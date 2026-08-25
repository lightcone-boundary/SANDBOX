import { cacheKey, NativeRuntimeStore } from "./native-cache.js"
import { fetchWithPolicy, responseText } from "./network.js"
import { normalizeArxivId } from "./arxiv-types.js"

const SEMANTIC_SCHOLAR_API = "https://api.semanticscholar.org/graph/v1"
const PAPER_FIELDS = "title,authors,year,citationCount,externalIds,abstract"
const GRAPH_CACHE_TTL_MS = 24 * 60 * 60 * 1_000

type JsonRecord = Record<string, unknown>

export type CitationCount = {
  citationCount: number
  influentialCitationCount: number
}

export type CitationGraphInput = {
  arxiv_id: string
  max_results?: number
}

export type CitationGraphOutput = {
  metadata: Record<string, unknown>
  output: string
}

export type CitationDependencies = {
  fetcher?: typeof fetch
  store?: NativeRuntimeStore
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error("Semantic Scholar returned invalid JSON", { cause: error })
  }
}

function requestHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "SANDBOX-Physics/0.2",
  }
  const apiKey = process.env.S2_API_KEY?.trim()
  if (apiKey) headers["x-api-key"] = apiKey
  return headers
}

async function semanticScholarRequest(
  url: string | URL,
  init: RequestInit,
  signal: AbortSignal | undefined,
  dependencies: CitationDependencies,
): Promise<unknown> {
  const store = dependencies.store ?? new NativeRuntimeStore()
  const response = await fetchWithPolicy(
    url,
    {
      ...init,
      headers: { ...requestHeaders(), ...init.headers },
    },
    {
      fetcher: dependencies.fetcher,
      minimumIntervalMs: 700,
      signal,
      store,
      throttleKey: "semantic_scholar",
      timeoutMs: 20_000,
    },
  )
  const text = await responseText(response, 5_000_000)
  if (!response.ok) {
    throw new Error(`Semantic Scholar request failed with HTTP ${response.status}: ${text.slice(0, 500)}`)
  }
  return parseJson(text)
}

export async function fetchCitationCounts(
  arxivIds: string[],
  signal?: AbortSignal,
  dependencies: CitationDependencies = {},
): Promise<Map<string, CitationCount>> {
  if (arxivIds.length === 0) return new Map()
  const payload = await semanticScholarRequest(
    new URL(`${SEMANTIC_SCHOLAR_API}/paper/batch?fields=citationCount,influentialCitationCount`),
    {
      body: JSON.stringify({ ids: arxivIds.map((id) => `arXiv:${id}`) }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
    signal,
    dependencies,
  )
  if (!Array.isArray(payload)) throw new Error("Semantic Scholar batch response was not an array")

  const counts = new Map<string, CitationCount>()
  payload.forEach((entry, index) => {
    if (!isRecord(entry) || index >= arxivIds.length) return
    counts.set(arxivIds[index], {
      citationCount: numberValue(entry.citationCount) ?? 0,
      influentialCitationCount: numberValue(entry.influentialCitationCount) ?? 0,
    })
  })
  return counts
}

function paperFromEntry(entry: unknown, direction: "citations" | "references"): JsonRecord | undefined {
  if (!isRecord(entry)) return undefined
  const nested = direction === "citations" ? entry.citingPaper : entry.citedPaper
  return isRecord(nested) ? nested : undefined
}

function authorLine(value: unknown): string {
  if (!Array.isArray(value)) return ""
  const names = value
    .filter(isRecord)
    .map((author) => stringValue(author.name))
    .filter(Boolean)
  const visible = names.slice(0, 5).join(", ")
  return names.length > 5 ? `${visible} et al. (${names.length} authors)` : visible
}

function externalArxivId(value: unknown): string {
  return isRecord(value) ? stringValue(value.ArXiv) : ""
}

function formatGraph(
  entries: unknown[],
  arxivId: string,
  direction: "citations" | "references",
  total: number | undefined,
): string {
  const references = direction === "references"
  const title = references ? "Paper References (Bibliography)" : "Paper Citations (Forward)"
  const directionLabel = references
    ? "backward — papers this paper cites"
    : "forward — papers that cite this paper"
  const lines = [
    `# ${title}`,
    "",
    `**Paper:** arXiv:${arxivId}`,
    `**Direction:** ${directionLabel}`,
    `**Results:** ${entries.length} papers`,
    "",
  ]

  let rendered = 0
  for (const entry of entries) {
    const paper = paperFromEntry(entry, direction)
    if (!paper) continue
    const paperTitle = stringValue(paper.title)
    if (!paperTitle) continue
    rendered += 1
    const metadata: string[] = []
    const paperArxivId = externalArxivId(paper.externalIds)
    const year = numberValue(paper.year)
    const citationCount = numberValue(paper.citationCount)
    if (paperArxivId) metadata.push(`**arXiv:** [${paperArxivId}](https://arxiv.org/abs/${paperArxivId})`)
    if (year !== undefined) metadata.push(`**Year:** ${year}`)
    if (citationCount !== undefined) metadata.push(`**Citations:** ${citationCount}`)

    lines.push(`## ${rendered}. ${paperTitle}`, "")
    if (metadata.length > 0) lines.push(metadata.join(" | "))
    const authors = authorLine(paper.authors)
    if (authors) lines.push(`**Authors:** ${authors}`)
    const abstract = stringValue(paper.abstract)
    if (abstract) lines.push("", abstract.length > 400 ? `${abstract.slice(0, 400)}...` : abstract)
    lines.push("", "---", "")
  }
  if (total !== undefined) lines.push(`_Showing ${rendered} of ${total} total ${direction}._`)
  return lines.join("\n")
}

export async function fetchCitationGraph(
  direction: "citations" | "references",
  input: CitationGraphInput,
  signal?: AbortSignal,
  dependencies: CitationDependencies = {},
): Promise<CitationGraphOutput> {
  const arxivId = normalizeArxivId(input.arxiv_id)
  const maxResults = Math.min(100, Math.max(1, input.max_results ?? 20))
  const store = dependencies.store ?? new NativeRuntimeStore()
  const key = cacheKey({ arxivId, direction, maxResults })
  const cached = store.getCachedText("citation_graph", key, GRAPH_CACHE_TTL_MS)
  if (cached !== undefined) {
    return { output: cached, metadata: { cached: true, direction } }
  }

  const endpoint = new URL(
    `${SEMANTIC_SCHOLAR_API}/paper/${encodeURIComponent(`arXiv:${arxivId}`)}/${direction}`,
  )
  endpoint.searchParams.set("fields", PAPER_FIELDS)
  endpoint.searchParams.set("limit", String(maxResults))
  const payload = await semanticScholarRequest(endpoint, { method: "GET" }, signal, {
    ...dependencies,
    store,
  })
  if (!isRecord(payload)) throw new Error("Semantic Scholar graph response was not an object")
  const entries = Array.isArray(payload.data) ? payload.data : []
  const total = numberValue(payload.total)
  const output = entries.length === 0
    ? `No ${direction} found for arXiv:${arxivId}. The paper may not be indexed by Semantic Scholar yet.`
    : formatGraph(entries, arxivId, direction, total)
  store.setCachedText("citation_graph", key, output)
  return {
    output,
    metadata: { cached: false, direction, results: entries.length, total },
  }
}
