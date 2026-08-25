import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { gunzipSync } from "node:zlib"

import { extract as createTarExtractor } from "tar-stream"
import { extractText, getDocumentProxy } from "unpdf"

import { NativeRuntimeStore } from "./native-cache.js"
import { fetchWithPolicy, responseBytes } from "./network.js"
import { arxivPaperRoot, sandboxHome } from "./paths.js"
import type { ArxivFetchInput, ArxivToolOutput } from "./arxiv-types.js"
import { normalizeArxivId } from "./arxiv-types.js"

const MAX_SOURCE_DOWNLOAD_BYTES = 60_000_000
const MAX_SOURCE_EXPANDED_BYTES = 200_000_000
const MAX_TEX_BYTES = 20_000_000
const MAX_PDF_BYTES = 80_000_000
const MAX_PDF_PAGES = 500
const MAX_PDF_IMAGE_PIXELS = 16_777_216

type TexCandidate = {
  content: string
  size: number
}

export type ArxivFetchDependencies = {
  fetcher?: typeof fetch
  home?: string
  store?: NativeRuntimeStore
}

function withTimeout<T>(operation: Promise<T>, milliseconds: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds)
    operation.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function archivePathIsSafe(path: string): boolean {
  const normalized = path.replaceAll("\\", "/")
  return !normalized.startsWith("/") && !normalized.split("/").includes("..")
}

function looksLikePlainTex(bytes: Uint8Array): boolean {
  const probe = Buffer.from(bytes.subarray(0, Math.min(bytes.byteLength, 32_768)))
  if (probe.includes(0)) return false
  const text = probe.toString("utf8")
  return text.includes("\\documentclass") || text.includes("\\begin{document}")
}

async function largestTexEntry(archive: Uint8Array): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve, reject) => {
    const extractor = createTarExtractor()
    const candidates: TexCandidate[] = []
    extractor.on("entry", (header, stream, next) => {
      const headerSize = header.size ?? 0
      const accepted = header.type === "file"
        && header.name.toLowerCase().endsWith(".tex")
        && archivePathIsSafe(header.name)
        && headerSize <= MAX_TEX_BYTES
      if (!accepted) {
        stream.on("end", next)
        stream.resume()
        return
      }

      const chunks: Buffer[] = []
      let size = 0
      stream.on("data", (chunk: Buffer) => {
        size += chunk.byteLength
        if (size <= MAX_TEX_BYTES) chunks.push(chunk)
      })
      stream.on("end", () => {
        if (size <= MAX_TEX_BYTES) {
          candidates.push({ content: Buffer.concat(chunks).toString("utf8"), size })
        }
        next()
      })
      stream.on("error", reject)
    })
    extractor.on("finish", () => {
      candidates.sort((left, right) => right.size - left.size)
      resolve(candidates[0]?.content)
    })
    extractor.on("error", reject)
    extractor.end(Buffer.from(archive))
  })
}

export async function extractLatexSource(bytes: Uint8Array): Promise<string | undefined> {
  let expanded = bytes
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      expanded = gunzipSync(bytes, { maxOutputLength: MAX_SOURCE_EXPANDED_BYTES })
    } catch {
      return undefined
    }
  }
  if (looksLikePlainTex(expanded)) return Buffer.from(expanded).toString("utf8")
  try {
    return await largestTexEntry(expanded)
  } catch {
    return undefined
  }
}

export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const pdfBytes = new Uint8Array(bytes)
  const proxy = await withTimeout(
    getDocumentProxy(pdfBytes, { maxImageSize: MAX_PDF_IMAGE_PIXELS }),
    30_000,
    "PDF loading",
  )
  if (proxy.numPages > MAX_PDF_PAGES) {
    throw new Error(`PDF has ${proxy.numPages} pages; limit is ${MAX_PDF_PAGES}`)
  }
  const result = await withTimeout(extractText(proxy, { mergePages: true }), 60_000, "PDF extraction")
  const text = result.text
  if (!text.trim()) throw new Error("PDF contained no extractable text")
  return text
}

function fileId(arxivId: string): string {
  return arxivId.replaceAll("/", "_")
}

function existingPaper(root: string, arxivId: string): string | undefined {
  if (!existsSync(root)) return undefined
  const prefix = `${fileId(arxivId)}--`
  return readdirSync(root).find((name) => name.startsWith(prefix) && name.endsWith(".md"))
}

function cleanTitle(value: string): string {
  let cleaned = value
  for (let index = 0; index < 5; index += 1) {
    const next = cleaned.replace(/\\(?:textbf|textit|emph)\{([^{}]*)\}/g, "$1")
    if (next === cleaned) break
    cleaned = next
  }
  return cleaned
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function isEscaped(value: string, index: number): boolean {
  let backslashes = 0
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    backslashes += 1
  }
  return backslashes % 2 === 1
}

function latexTitleArgument(content: string): string | undefined {
  const command = /\\title\s*(?:\[[^\]]*\]\s*)?\{/i.exec(content)
  if (!command) return undefined
  const start = command.index + command[0].lastIndexOf("{")
  let depth = 0
  const scanLimit = Math.min(content.length, start + 10_000)
  for (let index = start; index < scanLimit; index += 1) {
    const character = content[index]
    if (isEscaped(content, index)) continue
    if (character === "{") {
      depth += 1
      continue
    }
    if (character !== "}") continue
    depth -= 1
    if (depth === 0) return content.slice(start + 1, index)
  }
  return undefined
}

export function extractPaperTitle(content: string, arxivId: string): string {
  const latex = latexTitleArgument(content)
  if (latex !== undefined) return cleanTitle(latex) || `arXiv ${arxivId}`
  const markdown = /^#\s+(.+)$/m.exec(content)
  return markdown ? markdown[1].trim() : `arXiv ${arxivId}`
}

export function extractAbstract(content: string): string {
  const patterns = [
    /\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/i,
    /^#+\s*abstract\s*$\n([\s\S]*?)(?=^#+\s|\s*$)/im,
    /^abstract\s*$\n([\s\S]*?)(?=^\s*$|\s*$)/im,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(content)
    if (!match) continue
    const abstract = match[1].replace(/\s+/g, " ").trim()
    if (abstract) return abstract.slice(0, 800)
  }
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("\\") && !line.startsWith("#"))
  return lines.slice(0, 20).join(" ").replace(/\s+/g, " ").slice(0, 800)
}

function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .slice(0, 80)
    .replace(/^[-_.]+|[-_.]+$/g, "") || "paper"
}

function escapeIndexField(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\s+/g, " ").trim()
}

function updatePaperIndex(
  root: string,
  paperPath: string,
  arxivId: string,
  title: string,
  sourceType: string,
  savedAt: string,
  abstract: string,
): void {
  const indexPath = join(root, "index.md")
  const existing = existsSync(indexPath) ? readFileSync(indexPath, "utf8").split(/\r?\n/) : []
  const entries = existing.filter((line) => line.startsWith("- arxiv_id:") && !line.startsWith(`- arxiv_id: ${arxivId} |`))
  entries.push(
    `- arxiv_id: ${escapeIndexField(arxivId)} | title: ${escapeIndexField(title)} ` +
      `| source_type: ${sourceType} | saved_at: ${savedAt} | path: ${basename(paperPath)} ` +
      `| abstract: ${escapeIndexField(abstract.slice(0, 500))}`,
  )
  const document = [
    "# PhysicsArxiv Index",
    "",
    "Lightweight paper index for persisted arXiv papers. Use arxiv_fetch to retrieve papers and inspect the saved file for full text.",
    "",
    `- paper_files: ${entries.length}`,
    "",
    "## Entries",
    "",
    ...entries,
    "",
  ]
  writeFileSync(indexPath, document.join("\n"), "utf8")
}

function savePaper(
  root: string,
  arxivId: string,
  sourceType: string,
  content: string,
): { abstract: string; path: string; title: string } {
  mkdirSync(root, { recursive: true })
  const title = extractPaperTitle(content, arxivId)
  const abstract = extractAbstract(content)
  const previous = existingPaper(root, arxivId)
  const name = previous ?? `${fileId(arxivId)}--${slugifyTitle(title)}.md`
  const path = join(root, name)
  const savedAt = new Date().toISOString()
  const document = [
    `# ${title}`,
    "",
    `- arxiv_id: ${arxivId}`,
    `- source_type: ${sourceType}`,
    `- saved_at: ${savedAt}`,
    `- path_hint: PhysicsOcean/arxiv/${name}`,
    "",
    "## Abstract",
    "",
    abstract || "[not extracted]",
    "",
    "## Full Text",
    "",
    content.trim(),
    "",
  ].join("\n")
  writeFileSync(path, document, "utf8")
  updatePaperIndex(root, path, arxivId, title, sourceType, savedAt, abstract)
  return { abstract, path, title }
}

function extractSections(content: string, sections: string[]): string {
  if (sections.length === 0) return content
  const keywords = sections.map((section) => section.toLowerCase())
  const lines = content.split(/\r?\n/)
  const selected: string[] = []
  let collecting = false
  for (const line of lines) {
    const normalized = line.trim().toLowerCase()
    const heading = /^#{1,6}\s+/.test(normalized) || /^\\(?:sub)*section\{/.test(normalized)
    if (heading) {
      const matches = keywords.some((keyword) => normalized.includes(keyword))
      if (matches) {
        if (selected.length > 0) selected.push("")
        collecting = true
      } else if (collecting) {
        collecting = false
      }
    }
    if (collecting) selected.push(line)
  }
  return selected.length > 0 ? selected.join("\n") : content
}

async function download(
  url: string,
  maxBytes: number,
  signal: AbortSignal | undefined,
  dependencies: ArxivFetchDependencies,
): Promise<Uint8Array | undefined> {
  const store = dependencies.store ?? new NativeRuntimeStore()
  const response = await fetchWithPolicy(
    url,
    { headers: { "User-Agent": "SANDBOX-Physics/0.2" } },
    {
      fetcher: dependencies.fetcher,
      minimumIntervalMs: 3_000,
      signal,
      store,
      throttleKey: "arxiv",
      timeoutMs: 60_000,
    },
  )
  if (!response.ok) {
    if (response.body) await response.body.cancel()
    return undefined
  }
  return responseBytes(response, maxBytes)
}

export async function fetchArxivPaper(
  input: ArxivFetchInput,
  signal?: AbortSignal,
  dependencies: ArxivFetchDependencies = {},
): Promise<ArxivToolOutput> {
  const arxivId = normalizeArxivId(input.arxiv_id)
  const home = dependencies.home ?? sandboxHome()
  const root = arxivPaperRoot(home)
  const previous = existingPaper(root, arxivId)
  const maxLength = Math.min(200_000, Math.max(1_000, input.max_length ?? 50_000))
  if (previous && !input.force_refresh) {
    const path = join(root, previous)
    const saved = readFileSync(path, "utf8")
    const preview = extractAbstract(saved) || saved.slice(0, maxLength)
    return {
      output: `arXiv:${arxivId} is already saved at ${path}.\n\n${preview.slice(0, maxLength)}`,
      metadata: { cached: true, output_path: path, truncated: preview.length > maxLength },
    }
  }

  const sourceBytes = await download(
    `https://arxiv.org/e-print/${encodeURIComponent(arxivId)}`,
    MAX_SOURCE_DOWNLOAD_BYTES,
    signal,
    dependencies,
  )
  let content = sourceBytes ? await extractLatexSource(sourceBytes) : undefined
  let sourceType = "LaTeX"
  if (!content) {
    const pdfBytes = await download(
      `https://arxiv.org/pdf/${encodeURIComponent(arxivId)}`,
      MAX_PDF_BYTES,
      signal,
      dependencies,
    )
    if (!pdfBytes || Buffer.from(pdfBytes.subarray(0, 5)).toString("ascii") !== "%PDF-") {
      throw new Error(`Could not download source or PDF for arXiv:${arxivId}`)
    }
    content = await extractPdfText(pdfBytes)
    sourceType = "PDF"
  }

  const saved = savePaper(root, arxivId, sourceType, content)
  const focused = extractSections(content, input.sections ?? [])
  const previewSource = input.sections?.length ? focused : saved.abstract || focused
  const truncated = previewSource.length > maxLength
  const preview = previewSource.slice(0, maxLength)
  return {
    output: [
      `Saved arXiv:${arxivId} to ${saved.path}.`,
      `Indexed under ${join(root, "index.md")}.`,
      "Use native file search/read tools on the saved paper for deeper inspection.",
      "",
      `Title: ${saved.title}`,
      `Source type: ${sourceType}`,
      `Abstract snippet: ${saved.abstract || "[not extracted]"}`,
      "Focused preview:",
      preview + (truncated ? `\n\n[Preview truncated at ${maxLength} characters]` : ""),
    ].join("\n"),
    metadata: {
      cached: false,
      output_path: saved.path,
      source_type: sourceType,
      truncated,
    },
  }
}
