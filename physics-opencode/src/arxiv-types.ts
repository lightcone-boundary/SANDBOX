export type ArxivSort = "citation_count" | "relevance" | "submitted_date" | "updated_date"
export type SortOrder = "ascending" | "descending"

export type ArxivPaper = {
  abstract: string
  arxivId: string
  authors: string[]
  categories: string[]
  citationCount?: number
  comment?: string
  doi?: string
  influentialCitationCount?: number
  journalRef?: string
  pdfUrl: string
  primaryCategory: string
  published: string
  sourceUrl: string
  title: string
  updated: string
}

export type ArxivSearchInput = {
  author?: string
  category?: string
  date_from?: string
  date_to?: string
  include_citations?: boolean
  max_results?: number
  query: string
  sort_by?: ArxivSort
  sort_order?: SortOrder
}

export type ArxivFetchInput = {
  arxiv_id: string
  force_refresh?: boolean
  max_length?: number
  sections?: string[]
}

export type ArxivToolOutput = {
  metadata: Record<string, unknown>
  output: string
}

const MODERN_ID = /^\d{4}\.\d{4,5}(?:v\d+)?$/
const LEGACY_ID = /^[a-z][a-z0-9.-]*\/\d{7}(?:v\d+)?$/i

export function normalizeArxivId(value: string): string {
  const trimmed = value.trim().replace(/^arxiv:/i, "")
  if (!MODERN_ID.test(trimmed) && !LEGACY_ID.test(trimmed)) {
    throw new Error(`Invalid arXiv ID: ${value}`)
  }
  return trimmed
}

export function unversionedArxivId(value: string): string {
  return normalizeArxivId(value).replace(/v\d+$/i, "")
}
