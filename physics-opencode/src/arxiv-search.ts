import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"

import { XMLParser } from "fast-xml-parser"

import { fetchCitationCounts } from "./citations.js"
import type { CitationDependencies } from "./citations.js"
import { cacheKey, NativeRuntimeStore } from "./native-cache.js"
import { fetchWithPolicy, responseText } from "./network.js"
import { arxivMetadataDb, sandboxHome } from "./paths.js"
import type { ArxivPaper, ArxivSearchInput, ArxivToolOutput } from "./arxiv-types.js"

const ARXIV_API = "https://export.arxiv.org/api/query"
const SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1_000
const DEFAULT_MIN_LOCAL_ROWS = 100_000

type JsonRecord = Record<string, unknown>

type LocalPaperRow = {
  abstract: string
  arxiv_id: string
  authors: string
  categories: string
  doi: string | null
  journal_ref: string | null
  primary_category: string
  published: string
  title: string
  updated: string
}

type LocalSearch = {
  lastSynced: string
  papers: ArxivPaper[]
}

export type ArxivSearchDependencies = CitationDependencies & {
  home?: string
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : ""
}

function attribute(value: unknown, name: string): string {
  return isRecord(value) ? text(value[`@_${name}`]) : ""
}

function validateDate(value: string, label: string): string {
  if (!value) return ""
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must use YYYY-MM-DD format`)
  const parsed = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} is not a valid calendar date`)
  }
  return value
}

function looksLikeArxivQuery(query: string): boolean {
  return /(?:^|\s)(?:ti|au|abs|cat|co|jr|rn|id|all|submittedDate):|\b(?:AND|OR|ANDNOT)\b|[\[\]()]/.test(query)
}

function escapePhrase(value: string): string {
  return value.replaceAll('"', " ").replace(/\s+/g, " ").trim()
}

function dateBound(value: string, endOfDay: boolean): string {
  return value.replaceAll("-", "") + (endOfDay ? "2359" : "0000")
}

export function buildArxivQuery(input: ArxivSearchInput): string {
  const query = input.query.trim()
  const author = input.author?.trim() ?? ""
  const category = input.category?.trim() ?? ""
  const dateFrom = validateDate(input.date_from?.trim() ?? "", "date_from")
  const dateTo = validateDate(input.date_to?.trim() ?? "", "date_to")
  if (!query && !author && !category) {
    throw new Error("At least one of query, author, or category must be provided")
  }
  if (dateFrom && dateTo && dateFrom > dateTo) throw new Error("date_from must not be after date_to")

  const parts: string[] = []
  if (query) {
    if (looksLikeArxivQuery(query)) {
      parts.push(query)
    } else {
      const withoutYears = query
        .match(/[A-Za-z0-9][A-Za-z0-9.+-]*/g)
        ?.filter((token) => !/^(?:19|20)\d{2}$/.test(token))
        .join(" ")
      const phrase = escapePhrase(withoutYears || query)
      parts.push(phrase.includes(" ") ? `all:"${phrase}"` : `all:${phrase}`)
    }
  }
  if (author) parts.push(`au:"${escapePhrase(author)}"`)
  if (category) parts.push(`cat:${category.replace(/[^A-Za-z0-9.-]/g, "")}`)
  if (dateFrom || dateTo) {
    const start = dateBound(dateFrom || "1900-01-01", false)
    const end = dateBound(dateTo || new Date().toISOString().slice(0, 10), true)
    parts.push(`submittedDate:[${start} TO ${end}]`)
  }
  return parts.join(" AND ")
}

function ftsTerms(value: string): string {
  const tokens = value.match(/[A-Za-z0-9][A-Za-z0-9'+.-]*/g) ?? []
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" ")
}

function localRowToPaper(row: LocalPaperRow): ArxivPaper {
  return {
    abstract: row.abstract,
    arxivId: row.arxiv_id,
    authors: row.authors.split(",").map((name) => name.trim()).filter(Boolean),
    categories: row.categories.split(/\s+/).filter(Boolean),
    doi: row.doi ?? undefined,
    journalRef: row.journal_ref ?? undefined,
    pdfUrl: `https://arxiv.org/pdf/${row.arxiv_id}`,
    primaryCategory: row.primary_category,
    published: row.published,
    sourceUrl: `https://arxiv.org/e-print/${row.arxiv_id}`,
    title: row.title,
    updated: row.updated,
  }
}

function localMinimumRows(): number {
  const configured = Number(process.env.ARXIV_LOCAL_MIN_ROWS)
  return Number.isInteger(configured) && configured >= 0 ? configured : DEFAULT_MIN_LOCAL_ROWS
}

function queryLocalIndex(input: ArxivSearchInput, home: string): LocalSearch | undefined {
  if (input.query.trim() && looksLikeArxivQuery(input.query)) return undefined
  const databasePath = arxivMetadataDb(home)
  if (!existsSync(databasePath)) return undefined
  const database = new Database(databasePath, { readonly: true })
  try {
    const sync = database
      .query<{ value: string }, []>("SELECT value FROM sync_state WHERE key = 'last_synced_until'")
      .get()
    const count = database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM papers").get()
    if (!sync || !count || count.count < localMinimumRows()) return undefined
    const dateFrom = input.date_from?.trim() ?? ""
    const dateTo = input.date_to?.trim() ?? ""
    if ((dateFrom && dateFrom > sync.value) || (dateTo && dateTo > sync.value)) return undefined

    const matchParts: string[] = []
    const query = ftsTerms(input.query.trim())
    const author = ftsTerms(input.author?.trim() ?? "")
    const category = ftsTerms(input.category?.trim() ?? "")
    if (query) matchParts.push(`{title abstract} : (${query})`)
    if (author) matchParts.push(`authors : (${author})`)
    if (category) matchParts.push(`categories : (${category})`)
    if (matchParts.length === 0) return undefined

    const where = ["papers_fts MATCH ?"]
    const bindings: Array<string | number> = [matchParts.join(" AND ")]
    if (dateFrom) {
      where.push("p.published >= ?")
      bindings.push(dateFrom)
    }
    if (dateTo) {
      where.push("p.published <= ?")
      bindings.push(dateTo)
    }
    const direction = input.sort_order === "ascending" ? "ASC" : "DESC"
    const order = input.sort_by === "submitted_date"
      ? `p.published ${direction}`
      : input.sort_by === "updated_date"
        ? `p.updated ${direction}`
        : "bm25(papers_fts, 5.0, 1.0, 2.0, 1.0)"
    const maxResults = Math.min(50, Math.max(1, input.max_results ?? 10))
    bindings.push(maxResults)
    const sql =
      "SELECT p.arxiv_id, p.title, p.abstract, p.authors, p.categories, " +
      "p.primary_category, p.published, p.updated, p.doi, p.journal_ref " +
      "FROM papers_fts f JOIN papers p ON p.id = f.rowid " +
      `WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ?`
    const rows = database.query<LocalPaperRow, Array<string | number>>(sql).all(...bindings)
    if (rows.length === 0) return undefined
    return { lastSynced: sync.value, papers: rows.map(localRowToPaper) }
  } finally {
    database.close()
  }
}

function parseEntry(value: unknown): ArxivPaper | undefined {
  if (!isRecord(value)) return undefined
  const idUrl = text(value.id)
  const arxivId = idUrl.includes("/abs/") ? idUrl.split("/abs/").at(-1) ?? "" : idUrl
  if (!arxivId) return undefined
  const authors = asArray(value.author)
    .filter(isRecord)
    .map((author) => text(author.name))
    .filter(Boolean)
  const categories = asArray(value.category).map((category) => attribute(category, "term")).filter(Boolean)
  const links = asArray(value.link).filter(isRecord)
  const pdfLink = links.find((link) => attribute(link, "title") === "pdf")
  const primaryCategory = attribute(value.primary_category, "term") || categories[0] || ""
  return {
    abstract: text(value.summary),
    arxivId,
    authors,
    categories,
    comment: text(value.comment) || undefined,
    doi: text(value.doi) || undefined,
    journalRef: text(value.journal_ref) || undefined,
    pdfUrl: pdfLink ? attribute(pdfLink, "href") : `https://arxiv.org/pdf/${arxivId}`,
    primaryCategory,
    published: text(value.published).slice(0, 10),
    sourceUrl: `https://arxiv.org/e-print/${arxivId}`,
    title: text(value.title),
    updated: text(value.updated).slice(0, 10),
  }
}

export function parseArxivAtom(xml: string): ArxivPaper[] {
  const parser = new XMLParser({
    attributeNamePrefix: "@_",
    ignoreAttributes: false,
    parseTagValue: false,
    processEntities: false,
    removeNSPrefix: true,
    trimValues: true,
  })
  const parsed: unknown = parser.parse(xml)
  if (!isRecord(parsed) || !isRecord(parsed.feed)) return []
  return asArray(parsed.feed.entry).map(parseEntry).filter((paper): paper is ArxivPaper => paper !== undefined)
}

async function enrichPapers(
  papers: ArxivPaper[],
  signal: AbortSignal | undefined,
  dependencies: ArxivSearchDependencies,
): Promise<string | undefined> {
  try {
    const counts = await fetchCitationCounts(papers.map((paper) => paper.arxivId), signal, dependencies)
    for (const paper of papers) {
      const count = counts.get(paper.arxivId)
      if (!count) continue
      paper.citationCount = count.citationCount
      paper.influentialCitationCount = count.influentialCitationCount
    }
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function formatPapers(papers: ArxivPaper[], query: string, source: string, warning?: string): string {
  const lines = [
    "# arXiv Search Results",
    "",
    `**Query:** ${query}`,
    `**Results:** ${papers.length} papers | **Source:** ${source}`,
  ]
  if (warning) lines.push(`**Citation enrichment warning:** ${warning}`)
  lines.push("")
  papers.forEach((paper, index) => {
    const metadata = [
      `**arXiv:** [${paper.arxivId}](${paper.pdfUrl})`,
      `**Published:** ${paper.published}`,
    ]
    if (paper.doi) metadata.push(`**DOI:** [${paper.doi}](https://doi.org/${encodeURIComponent(paper.doi)})`)
    if (paper.citationCount !== undefined) {
      const influential = paper.influentialCitationCount
        ? ` (${paper.influentialCitationCount} influential)`
        : ""
      metadata.push(`**Citations:** ${paper.citationCount}${influential}`)
    }
    const authorSuffix = paper.authors.length > 5 ? ` et al. (${paper.authors.length} authors)` : ""
    lines.push(
      `## ${index + 1}. ${paper.title}`,
      "",
      metadata.join(" | "),
      `**Authors:** ${paper.authors.slice(0, 5).join(", ")}${authorSuffix}`,
      `**Categories:** ${paper.categories.join(", ")}`,
    )
    if (paper.journalRef) lines.push(`**Published in:** ${paper.journalRef}`)
    const abstract = paper.abstract.length > 500 ? `${paper.abstract.slice(0, 500)}...` : paper.abstract
    lines.push("", abstract, "", "---", "")
  })
  return lines.join("\n")
}

export async function searchArxiv(
  input: ArxivSearchInput,
  signal?: AbortSignal,
  dependencies: ArxivSearchDependencies = {},
): Promise<ArxivToolOutput> {
  const query = buildArxivQuery(input)
  const store = dependencies.store ?? new NativeRuntimeStore()
  const home = dependencies.home ?? sandboxHome()
  const includeCitations = input.include_citations ?? true
  let local: LocalSearch | undefined
  let localWarning: string | undefined
  try {
    local = queryLocalIndex(input, home)
  } catch (error) {
    localWarning = error instanceof Error ? error.message : String(error)
  }

  if (local) {
    const warning = includeCitations ? await enrichPapers(local.papers, signal, { ...dependencies, store }) : undefined
    if (input.sort_by === "citation_count") {
      local.papers.sort((left, right) => {
        const difference = (left.citationCount ?? 0) - (right.citationCount ?? 0)
        return input.sort_order === "ascending" ? difference : -difference
      })
    }
    return {
      output: formatPapers(local.papers, query, `local arXiv mirror, synced through ${local.lastSynced}`, warning),
      metadata: { cached: false, results: local.papers.length, source: "local" },
    }
  }

  const key = cacheKey({ ...input, query })
  const cached = store.getCachedText("arxiv_search", key, SEARCH_CACHE_TTL_MS)
  if (cached !== undefined) {
    return { output: cached, metadata: { cached: true, source: "live" } }
  }

  const endpoint = new URL(ARXIV_API)
  endpoint.searchParams.set("search_query", query)
  endpoint.searchParams.set("start", "0")
  endpoint.searchParams.set("max_results", String(Math.min(50, Math.max(1, input.max_results ?? 10))))
  const sortMap = { relevance: "relevance", submitted_date: "submittedDate", updated_date: "lastUpdatedDate", citation_count: "relevance" }
  endpoint.searchParams.set("sortBy", sortMap[input.sort_by ?? "relevance"])
  endpoint.searchParams.set("sortOrder", input.sort_order ?? "descending")
  const response = await fetchWithPolicy(
    endpoint,
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
  const xml = await responseText(response, 5_000_000)
  if (!response.ok) throw new Error(`arXiv search failed with HTTP ${response.status}: ${xml.slice(0, 500)}`)
  const papers = parseArxivAtom(xml)
  if (papers.length === 0) {
    return { output: `No papers found for query: ${query}`, metadata: { results: 0, source: "live" } }
  }
  const citationWarning = includeCitations ? await enrichPapers(papers, signal, { ...dependencies, store }) : undefined
  if (input.sort_by === "citation_count") {
    papers.sort((left, right) => {
      const difference = (left.citationCount ?? 0) - (right.citationCount ?? 0)
      return input.sort_order === "ascending" ? difference : -difference
    })
  }
  const warnings = [localWarning, citationWarning].filter(Boolean).join("; ") || undefined
  const output = formatPapers(papers, query, "live arXiv API", warnings)
  store.setCachedText("arxiv_search", key, output)
  return {
    output,
    metadata: { cached: false, results: papers.length, source: "live" },
  }
}
