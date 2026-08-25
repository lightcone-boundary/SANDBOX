import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  readPhysicsSource,
  sanitizeFtsQuery,
  searchPhysicsCatalog,
  searchPhysicsOcean,
} from "../src/physics-ocean.js"
import { physicsTools } from "../src/physics-tools.js"

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function physicsOceanFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sandbox-physics-ocean-"))
  temporaryRoots.push(root)
  const home = join(root, "home")
  const ocean = join(home, "PhysicsOcean")
  await mkdir(ocean, { recursive: true })

  const catalog = [
    "# PhysicsOcean Books Catalog",
    "",
    "One line per book.",
    "",
    "Format: test fixture",
    "Subject tags: relativity-gr, quantum-mechanics",
    "Levels: undergrad, grad",
    "Kinds: textbook",
    "",
    "## Books",
    "",
    "- file: Relativity Primer.tex | subjects: relativity-gr | level: undergrad | kind: textbook | author: A. Einstein",
    "- file: Quantum Notes.tex | subjects: quantum-mechanics | level: grad | kind: lecture-notes | author: P. Dirac",
    "",
  ].join("\n")
  await writeFile(join(ocean, "books.md"), catalog)

  const source = Array.from({ length: 450 }, (_, index) => {
    if (index === 9) return "\\section{Gravitational Waves}"
    if (index === 10) return "The linearized field equation is $\\Box \\bar h_{\\mu\\nu}=0$."
    if (index === 199) return "\\section{Black Holes}"
    return `Relativity source line ${index + 1}`
  }).join("\n")
  await writeFile(join(ocean, "Relativity Primer.tex"), source)

  const database = new Database(join(ocean, "search.db"), { create: true })
  database.run(
    "CREATE VIRTUAL TABLE passages USING fts5(" +
      "text, book, section, path UNINDEXED, line_start UNINDEXED, line_end UNINDEXED, " +
      "tokenize='porter unicode61')",
  )
  const insert = database.query(
    "INSERT INTO passages(text, book, section, path, line_start, line_end) VALUES (?, ?, ?, ?, ?, ?)",
  )
  insert.run(
    "Gravitational waves solve the linearized Einstein field equation in vacuum.",
    "Relativity Primer",
    "Gravitational Waves",
    "Relativity Primer.tex",
    10,
    80,
  )
  insert.run(
    "Black hole event horizons and Schwarzschild geometry.",
    "Relativity Primer",
    "Black Holes",
    "Relativity Primer.tex",
    200,
    260,
  )
  database.close()
  return home
}

describe("PhysicsOcean native retrieval", () => {
  test("sanitizes FTS terms while preserving exact phrases", () => {
    expect(sanitizeFtsQuery('gravity "event horizon" + spin')).toBe(
      '"event horizon" "gravity" "spin"',
    )
    expect(sanitizeFtsQuery("   ")).toBe("")
  })

  test("routes through catalog, ranked passages, and table of contents", async () => {
    const home = await physicsOceanFixture()

    const catalog = searchPhysicsCatalog({ query: "relativity-gr", limit: 5 }, home)
    expect(catalog.metadata.matches).toBe(1)
    expect(catalog.output).toContain("Relativity Primer.tex")
    expect(catalog.output).not.toContain("Quantum Notes.tex")

    const search = searchPhysicsOcean({ query: '"gravitational waves"', limit: 5 }, home)
    expect(search.metadata.matches).toBe(1)
    expect(search.output).toContain("Relativity Primer.tex:10-80")
    expect(search.output).toContain("Use physics_read")

    const toc = searchPhysicsOcean({ toc: "Relativity Primer" }, home)
    expect(toc.metadata.mode).toBe("toc")
    expect(toc.output).toContain("L10: Gravitational Waves")
    expect(toc.output).toContain("L200: Black Holes")
  })

  test("reads bounded source lines and rejects directory traversal", async () => {
    const home = await physicsOceanFixture()
    const result = readPhysicsSource(
      { source: "Relativity Primer.tex", line_start: 1, line_end: 999 },
      home,
    )

    expect(result.metadata.line_start).toBe(1)
    expect(result.metadata.line_end).toBe(400)
    expect(result.metadata.truncated).toBe(true)
    expect(result.output).toContain("11: The linearized field equation")
    expect(() => readPhysicsSource({ source: "../outside.tex" }, home)).toThrow(
      "source must be a PhysicsOcean .tex filename without directories",
    )
  })

  test("registers the complete native tool surface", () => {
    expect(Object.keys(physicsTools).sort()).toEqual([
      "arxiv_fetch",
      "arxiv_search",
      "paper_citations",
      "paper_references",
      "physics_catalog",
      "physics_read",
      "physics_search",
    ])
  })
})
