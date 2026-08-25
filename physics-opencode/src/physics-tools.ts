import { tool } from "@opencode-ai/plugin"

import { fetchArxivPaper } from "./arxiv-fetch.js"
import { searchArxiv } from "./arxiv-search.js"
import { fetchCitationGraph } from "./citations.js"
import {
  readPhysicsSource,
  searchPhysicsCatalog,
  searchPhysicsOcean,
} from "./physics-ocean.js"

const z = tool.schema

type NativeOutput = {
  metadata: Record<string, unknown>
  output: string
}

function success(title: string, result: NativeOutput) {
  return {
    title,
    output: result.output,
    metadata: { ...result.metadata, success: true },
  }
}

function failure(title: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return {
    title,
    output: `Error: ${message}`,
    metadata: { success: false },
  }
}

export const physics_catalog = tool({
  description: "List or filter the PhysicsOcean textbook catalog by subject, author, level, title, or kind.",
  args: {
    query: z.string().optional().describe("Optional case-insensitive catalog filter such as relativity-gr, quantum, or problems-solutions"),
    limit: z.number().int().min(1).max(100).default(20),
  },
  async execute(input) {
    try {
      return success("physics_catalog", searchPhysicsCatalog(input))
    } catch (error) {
      return failure("physics_catalog", error)
    }
  },
})

export const physics_search = tool({
  description: "Search the PhysicsOcean textbook index for ranked passages, or return one book's table of contents.",
  args: {
    query: z.string().optional().describe("Physics concepts or an exact quoted phrase to search"),
    book: z.string().optional().describe("Optional book-name filter"),
    toc: z.string().optional().describe("Return the table of contents for the matching book instead of searching passages"),
    limit: z.number().int().min(1).max(50).default(10),
    snippet_tokens: z.number().int().min(8).max(64).default(24),
  },
  async execute(input) {
    try {
      return success("physics_search", searchPhysicsOcean(input))
    } catch (error) {
      return failure("physics_search", error)
    }
  },
})

export const physics_read = tool({
  description: "Read a bounded line range from a PhysicsOcean LaTeX source returned by physics_search.",
  args: {
    source: z.string().describe("PhysicsOcean .tex filename returned by physics_search"),
    line_start: z.number().int().min(1).default(1),
    line_end: z.number().int().min(1).optional(),
  },
  async execute(input) {
    try {
      return success("physics_read", readPhysicsSource(input))
    } catch (error) {
      return failure("physics_read", error)
    }
  },
})

export const arxiv_search = tool({
  description: "Search the local arXiv physics mirror or live arXiv API by topic, author, category, and date, with optional citation counts.",
  args: {
    query: z.string().default("").describe("Topic, keywords, or advanced arXiv query syntax"),
    author: z.string().optional().describe("Optional author filter such as Hawking or S. Weinberg"),
    category: z.string().optional().describe("Optional arXiv category such as quant-ph or hep-th"),
    date_from: z.string().optional().describe("Optional start date in YYYY-MM-DD format"),
    date_to: z.string().optional().describe("Optional end date in YYYY-MM-DD format"),
    sort_by: z.enum(["relevance", "submitted_date", "updated_date", "citation_count"]).default("relevance"),
    sort_order: z.enum(["descending", "ascending"]).default("descending"),
    max_results: z.number().int().min(1).max(50).default(10),
    include_citations: z.boolean().default(true),
  },
  async execute(input, context) {
    try {
      return success("arxiv_search", await searchArxiv(input, context.abort))
    } catch (error) {
      return failure("arxiv_search", error)
    }
  },
})

export const arxiv_fetch = tool({
  description: "Fetch and save an arXiv paper, preferring LaTeX source and using native PDF.js text extraction as fallback.",
  args: {
    arxiv_id: z.string().describe("arXiv paper ID such as 2103.14030, 2103.14030v2, or hep-th/9901001"),
    sections: z.array(z.string()).optional().describe("Optional section names to include in the preview"),
    max_length: z.number().int().min(1_000).max(200_000).default(50_000),
    force_refresh: z.boolean().default(false),
  },
  async execute(input, context) {
    try {
      return success("arxiv_fetch", await fetchArxivPaper(input, context.abort))
    } catch (error) {
      return failure("arxiv_fetch", error)
    }
  },
})

export const paper_references = tool({
  description: "Fetch the bibliography of an arXiv paper from Semantic Scholar for backward citation-graph exploration.",
  args: {
    arxiv_id: z.string().describe("arXiv paper ID such as 2103.14030"),
    max_results: z.number().int().min(1).max(100).default(20),
  },
  async execute(input, context) {
    try {
      return success("paper_references", await fetchCitationGraph("references", input, context.abort))
    } catch (error) {
      return failure("paper_references", error)
    }
  },
})

export const paper_citations = tool({
  description: "Fetch papers that cite an arXiv paper from Semantic Scholar for forward citation-graph exploration.",
  args: {
    arxiv_id: z.string().describe("arXiv paper ID such as 2103.14030"),
    max_results: z.number().int().min(1).max(100).default(20),
  },
  async execute(input, context) {
    try {
      return success("paper_citations", await fetchCitationGraph("citations", input, context.abort))
    } catch (error) {
      return failure("paper_citations", error)
    }
  },
})

export const physicsTools = {
  arxiv_fetch,
  arxiv_search,
  paper_citations,
  paper_references,
  physics_catalog,
  physics_read,
  physics_search,
}
