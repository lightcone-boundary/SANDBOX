import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { gzipSync } from "node:zlib"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  extractAbstract,
  extractLatexSource,
  extractPaperTitle,
  extractPdfText,
} from "../src/arxiv-fetch.js"
import { buildArxivQuery, parseArxivAtom, searchArxiv } from "../src/arxiv-search.js"
import { fetchCitationGraph } from "../src/citations.js"
import { NativeRuntimeStore } from "../src/native-cache.js"

const temporaryRoots: string[] = []
const originalLocalMinimum = process.env.ARXIV_LOCAL_MIN_ROWS

afterEach(async () => {
  if (originalLocalMinimum === undefined) delete process.env.ARXIV_LOCAL_MIN_ROWS
  else process.env.ARXIV_LOCAL_MIN_ROWS = originalLocalMinimum
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sandbox-arxiv-native-"))
  temporaryRoots.push(root)
  return root
}

async function localArxivFixture(): Promise<{ home: string; store: NativeRuntimeStore }> {
  const root = await temporaryRoot()
  const home = join(root, "home")
  const ocean = join(home, "PhysicsOcean")
  await mkdir(ocean, { recursive: true })
  const database = new Database(join(ocean, "arxiv_meta.db"), { create: true })
  database.run("CREATE TABLE sync_state(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
  database.run("INSERT INTO sync_state(key, value) VALUES ('last_synced_until', '2026-08-24')")
  database.run(
    "CREATE TABLE papers(" +
      "id INTEGER PRIMARY KEY, arxiv_id TEXT NOT NULL, title TEXT NOT NULL, abstract TEXT NOT NULL, " +
      "authors TEXT NOT NULL, categories TEXT NOT NULL, primary_category TEXT NOT NULL, " +
      "published TEXT NOT NULL, updated TEXT NOT NULL, doi TEXT, journal_ref TEXT)",
  )
  database.run("CREATE VIRTUAL TABLE papers_fts USING fts5(title, abstract, authors, categories)")
  database.query(
    "INSERT INTO papers(id, arxiv_id, title, abstract, authors, categories, primary_category, " +
      "published, updated, doi, journal_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    1,
    "2401.01234",
    "Gravitational Wave Memory in Compact Binaries",
    "We study nonlinear gravitational wave memory and observable signatures.",
    "Ada Lovelace, Emmy Noether",
    "gr-qc astro-ph.HE",
    "gr-qc",
    "2024-01-03",
    "2024-02-04",
    "10.1000/example",
    "Physical Review D 110",
  )
  database.query(
    "INSERT INTO papers_fts(rowid, title, abstract, authors, categories) VALUES (?, ?, ?, ?, ?)",
  ).run(
    1,
    "Gravitational Wave Memory in Compact Binaries",
    "We study nonlinear gravitational wave memory and observable signatures.",
    "Ada Lovelace, Emmy Noether",
    "gr-qc astro-ph.HE",
  )
  database.close()
  return {
    home,
    store: new NativeRuntimeStore(join(home, "shared", "test-runtime.db")),
  }
}

function onePagePdf(text: string): Uint8Array {
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)")
  const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${escaped}) Tj\nET`
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`,
  ]
  let document = "%PDF-1.4\n"
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(document, "ascii"))
    document += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xrefOffset = Buffer.byteLength(document, "ascii")
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  document += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(document, "ascii")
}

function testFetch(
  handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(handler, {
    preconnect(_url: string | URL): void {},
  })
}

describe("native arXiv parsing and local search", () => {
  test("builds validated API queries and parses Atom entries", () => {
    expect(buildArxivQuery({
      query: "quantum gravity 2024",
      author: "A. Einstein",
      category: "gr-qc",
      date_from: "2024-01-01",
      date_to: "2024-12-31",
    })).toBe(
      'all:"quantum gravity" AND au:"A. Einstein" AND cat:gr-qc AND submittedDate:[202401010000 TO 202412312359]',
    )
    expect(() => buildArxivQuery({ query: "gravity", date_from: "2024-02-30" })).toThrow(
      "date_from is not a valid calendar date",
    )

    const papers = parseArxivAtom(`<?xml version="1.0" encoding="UTF-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
        <entry>
          <id>https://arxiv.org/abs/2401.01234v2</id>
          <updated>2024-02-04T00:00:00Z</updated>
          <published>2024-01-03T00:00:00Z</published>
          <title>  Gravitational   Wave Memory  </title>
          <summary>Observable signatures.</summary>
          <author><name>Ada Lovelace</name></author>
          <category term="gr-qc" />
          <arxiv:primary_category term="gr-qc" />
          <link title="pdf" href="https://arxiv.org/pdf/2401.01234v2" />
        </entry>
      </feed>`)
    expect(papers).toHaveLength(1)
    expect(papers[0]?.arxivId).toBe("2401.01234v2")
    expect(papers[0]?.title).toBe("Gravitational Wave Memory")
    expect(papers[0]?.authors).toEqual(["Ada Lovelace"])
    expect(papers[0]?.primaryCategory).toBe("gr-qc")
  })

  test("uses a complete local FTS mirror without touching the network", async () => {
    const { home, store } = await localArxivFixture()
    process.env.ARXIV_LOCAL_MIN_ROWS = "0"
    let networkCalls = 0
    const fetcher = testFetch(async (): Promise<Response> => {
      networkCalls += 1
      throw new Error("network should not be used")
    })

    const result = await searchArxiv(
      {
        query: "gravitational memory",
        include_citations: false,
        max_results: 5,
        sort_by: "relevance",
        sort_order: "descending",
      },
      undefined,
      { fetcher, home, store },
    )

    expect(networkCalls).toBe(0)
    expect(result.metadata.source).toBe("local")
    expect(result.metadata.results).toBe(1)
    expect(result.output).toContain("local arXiv mirror, synced through 2026-08-24")
    expect(result.output).toContain("Gravitational Wave Memory in Compact Binaries")
    expect(result.output).toContain("10.1000/example")
  })
})

describe("native paper extraction and citations", () => {
  test("extracts plain and gzipped LaTeX metadata", async () => {
    const latex = String.raw`\documentclass{article}
\title{A \textbf{Native} Physics Paper}
\begin{document}
\begin{abstract}A test of native source extraction.\end{abstract}
\end{document}`

    expect(await extractLatexSource(Buffer.from(latex))).toBe(latex)
    expect(await extractLatexSource(gzipSync(latex))).toBe(latex)
    expect(extractPaperTitle(latex, "2401.01234")).toBe("A Native Physics Paper")
    expect(extractAbstract(latex)).toBe("A test of native source extraction.")
  })

  test("extracts text from a real one-page PDF fixture", async () => {
    const text = await extractPdfText(onePagePdf("SANDBOX native PDF extraction"))
    expect(text.replace(/\s+/g, " ")).toContain("SANDBOX native PDF extraction")
  })

  test("formats citation graph responses without a live API", async () => {
    const root = await temporaryRoot()
    const store = new NativeRuntimeStore(join(root, "runtime.db"))
    const fetcher = testFetch(async (): Promise<Response> => new Response(JSON.stringify({
      total: 1,
      data: [{
        citedPaper: {
          title: "Foundations of Native Physics Tools",
          authors: [{ name: "Emmy Noether" }],
          year: 1918,
          citationCount: 42,
          externalIds: { ArXiv: "2401.00001" },
          abstract: "A deterministic fixture.",
        },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }))

    const result = await fetchCitationGraph(
      "references",
      { arxiv_id: "2401.01234", max_results: 5 },
      undefined,
      { fetcher, store },
    )

    expect(result.metadata.results).toBe(1)
    expect(result.output).toContain("Paper References (Bibliography)")
    expect(result.output).toContain("Foundations of Native Physics Tools")
    expect(result.output).toContain("2401.00001")
  })
})
