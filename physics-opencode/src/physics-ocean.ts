import { Database } from "bun:sqlite"
import { existsSync, lstatSync, readFileSync } from "node:fs"
import { basename, extname, join } from "node:path"

import { physicsOceanRoot, physicsOceanSearchDb, sandboxHome } from "./paths.js"

const PART_LABEL = / \(part \d+\/\d+\)$/
const MAX_READ_LINES = 400
const MAX_READ_CHARACTERS = 80_000

type SearchRow = {
  book: string
  line_end: number
  line_start: number
  path: string
  score: number
  section: string
  snippet: string
}

type BookRow = {
  book: string
}

type SectionRow = {
  line_start: number
  path: string
  section: string
}

export type PhysicsSearchInput = {
  book?: string
  limit?: number
  query?: string
  snippet_tokens?: number
  toc?: string
}

export type PhysicsCatalogInput = {
  limit?: number
  query?: string
}

export type PhysicsReadInput = {
  line_end?: number
  line_start?: number
  source: string
}

export type PhysicsOceanOutput = {
  metadata: Record<string, unknown>
  output: string
}

export function sanitizeFtsQuery(query: string): string {
  const phrases = [...query.matchAll(/"([^"]+)"/g)].map((match) => match[1].trim())
  const remainder = query.replace(/"[^"]*"/g, " ")
  const tokens = remainder.match(/[A-Za-z0-9][A-Za-z0-9'+.-]*/g) ?? []
  return [
    ...phrases.filter(Boolean).map((phrase) => `"${phrase.replaceAll('"', '""')}"`),
    ...tokens.map((token) => `"${token.replaceAll('"', '""')}"`),
  ].join(" ")
}

function sourceName(path: string, book: string): string {
  const normalized = path.replaceAll("\\", "/")
  const candidate = normalized.split("/").at(-1) ?? ""
  if (candidate && extname(candidate).toLowerCase() === ".tex") return candidate
  return `${book}.tex`
}

function openSearchDatabase(home: string): Database {
  const databasePath = physicsOceanSearchDb(home)
  if (!existsSync(databasePath)) {
    throw new Error(`PhysicsOcean search index not found at ${databasePath}. Run \`sandbox data install\` first.`)
  }
  return new Database(databasePath, { readonly: true })
}

function runTableOfContents(database: Database, requestedBook: string): PhysicsOceanOutput {
  const expression = sanitizeFtsQuery(requestedBook)
  if (!expression) throw new Error("A non-empty book name is required for a table of contents")

  const books = database
    .query<BookRow, [string]>("SELECT DISTINCT book FROM passages WHERE passages MATCH ?")
    .all(`book:(${expression})`)
  if (books.length === 0) {
    return {
      output: `No PhysicsOcean book matched: ${requestedBook}`,
      metadata: { books: 0, mode: "toc" },
    }
  }
  if (books.length > 1) {
    const choices = books.slice(0, 20).map((row) => `- ${row.book}`).join("\n")
    return {
      output: `# ${books.length} books matched "${requestedBook}"\n\n${choices}\n\nNarrow the book name and retry.`,
      metadata: { books: books.length, mode: "toc" },
    }
  }

  const book = books[0].book
  const escapedBook = book.replaceAll('"', '""')
  const sections = database
    .query<SectionRow, [string]>(
      "SELECT section, path, line_start FROM passages WHERE passages MATCH ? ORDER BY line_start",
    )
    .all(`book:"${escapedBook}"`)
  const seen = new Set<string>()
  const lines: string[] = []
  for (const row of sections) {
    const section = row.section.replace(PART_LABEL, "")
    if (seen.has(section)) continue
    seen.add(section)
    lines.push(`- L${row.line_start}: ${section}`)
  }
  const source = sections[0] ? sourceName(sections[0].path, book) : `${book}.tex`
  return {
    output: `# TOC: ${book}\n\nSource: ${source}\n\n${lines.join("\n")}`,
    metadata: { book, mode: "toc", sections: lines.length, source },
  }
}

export function searchPhysicsOcean(
  input: PhysicsSearchInput,
  home = sandboxHome(),
): PhysicsOceanOutput {
  const database = openSearchDatabase(home)
  try {
    if (input.toc?.trim()) return runTableOfContents(database, input.toc.trim())

    const expression = sanitizeFtsQuery(input.query?.trim() ?? "")
    if (!expression) throw new Error("Provide a search query or a book name in toc")
    const bookExpression = sanitizeFtsQuery(input.book?.trim() ?? "")
    const matchExpression = bookExpression
      ? `(${expression}) AND book:(${bookExpression})`
      : expression
    const limit = Math.min(50, Math.max(1, input.limit ?? 10))
    const snippetTokens = Math.min(64, Math.max(8, input.snippet_tokens ?? 24))
    const rows = database
      .query<SearchRow, [number, string, number]>(
        "SELECT book, section, path, line_start, line_end, " +
          "snippet(passages, 0, '**', '**', '…', ?) AS snippet, " +
          "bm25(passages, 1.0, 2.0, 4.0) AS score " +
          "FROM passages WHERE passages MATCH ? ORDER BY score LIMIT ?",
      )
      .all(snippetTokens, matchExpression, limit)

    if (rows.length === 0) {
      return {
        output: `No PhysicsOcean passages matched: ${matchExpression}\nTry fewer terms, synonyms, or physics_catalog to check coverage.`,
        metadata: { matches: 0, query: matchExpression },
      }
    }

    const rendered = rows.map((row, index) => {
      const source = sourceName(row.path, row.book)
      return [
        `${index + 1}. [${row.book}] § ${row.section}`,
        `   Source: ${source}:${row.line_start}-${row.line_end} (score ${(-row.score).toFixed(1)})`,
        `   "${row.snippet}"`,
      ].join("\n")
    })
    return {
      output: `# ${rows.length} PhysicsOcean passages\n\n${rendered.join("\n\n")}\n\nUse physics_read with the source and line range for verbatim equations and context.`,
      metadata: { matches: rows.length, query: matchExpression },
    }
  } finally {
    database.close()
  }
}

export function searchPhysicsCatalog(
  input: PhysicsCatalogInput,
  home = sandboxHome(),
): PhysicsOceanOutput {
  const catalogPath = join(physicsOceanRoot(home), "books.md")
  if (!existsSync(catalogPath)) {
    throw new Error(`PhysicsOcean catalog not found at ${catalogPath}. Run \`sandbox data install\` first.`)
  }
  const allLines = readFileSync(catalogPath, "utf8").split(/\r?\n/)
  const header = allLines.slice(0, 12).join("\n")
  const query = input.query?.trim().toLowerCase() ?? ""
  const limit = Math.min(100, Math.max(1, input.limit ?? 20))
  const entries = allLines
    .filter((line) => line.startsWith("- file:"))
    .filter((line) => !query || line.toLowerCase().includes(query))
    .slice(0, limit)
  const label = query ? ` matching "${input.query?.trim()}"` : ""
  return {
    output: `${header}\n\n## Books${label}\n\n${entries.join("\n") || "No books matched."}`,
    metadata: { matches: entries.length, query },
  }
}

export function readPhysicsSource(
  input: PhysicsReadInput,
  home = sandboxHome(),
): PhysicsOceanOutput {
  const requested = input.source.trim().replaceAll("\\", "/")
  const fileName = basename(requested)
  if (!fileName || fileName !== requested || extname(fileName).toLowerCase() !== ".tex") {
    throw new Error("source must be a PhysicsOcean .tex filename without directories")
  }

  const sourcePath = join(physicsOceanRoot(home), fileName)
  if (!existsSync(sourcePath) || !lstatSync(sourcePath).isFile()) {
    throw new Error(`PhysicsOcean source not found: ${fileName}`)
  }
  const lines = readFileSync(sourcePath, "utf8").split(/\r?\n/)
  const lineStart = Math.min(lines.length || 1, Math.max(1, input.line_start ?? 1))
  const requestedEnd = input.line_end ?? lineStart + 119
  const lineEnd = Math.min(lines.length, Math.max(lineStart, requestedEnd), lineStart + MAX_READ_LINES - 1)
  const numbered: string[] = []
  let characters = 0
  for (let index = lineStart - 1; index < lineEnd; index += 1) {
    const rendered = `${index + 1}: ${lines[index]}`
    if (characters + rendered.length + 1 > MAX_READ_CHARACTERS) break
    numbered.push(rendered)
    characters += rendered.length + 1
  }
  const actualEnd = lineStart + numbered.length - 1
  return {
    output: `# ${fileName}:${lineStart}-${actualEnd}\n\n\`\`\`tex\n${numbered.join("\n")}\n\`\`\``,
    metadata: {
      line_end: actualEnd,
      line_start: lineStart,
      path: sourcePath,
      source: fileName,
      truncated: actualEnd < requestedEnd,
    },
  }
}
