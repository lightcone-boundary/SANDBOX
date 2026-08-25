import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { createWriteStream } from "node:fs"
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { pipeline } from "node:stream/promises"
import { createGzip } from "node:zlib"
import { pack, type Headers, type Pack } from "tar-stream"

import { getPhysicsOceanStatus, installPhysicsOceanPacks } from "../src/data-installer.js"

interface TestEntry {
  header: Headers
  body?: Buffer | string
}

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sandbox-data-installer-"))
  temporaryRoots.push(root)
  return root
}

function addEntry(archive: Pack, entry: TestEntry): Promise<void> {
  const body = Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(entry.body ?? "")
  return new Promise((resolve, reject) => {
    archive.entry({ ...entry.header, size: body.byteLength }, body, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

async function createPack(path: string, entries: TestEntry[]): Promise<void> {
  const archive = pack()
  const writing = pipeline(archive, createGzip(), createWriteStream(path))
  for (const entry of entries) await addEntry(archive, entry)
  archive.finalize()
  await writing
}

async function writeChecksum(packPath: string, checksum?: string): Promise<void> {
  const actual = checksum ?? createHash("sha256").update(await readFile(packPath)).digest("hex")
  await writeFile(`${packPath}.sha256`, `${actual}  ${basename(packPath)}\n`)
}

async function sqliteBuffer(root: string): Promise<Buffer> {
  const path = join(root, "source.db")
  const database = new Database(path)
  database.run("CREATE TABLE passages(id INTEGER PRIMARY KEY, text TEXT NOT NULL)")
  database.run("INSERT INTO passages(text) VALUES ('relativity')")
  database.close()
  return readFile(path)
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT" ? false : Promise.reject(error)
  }
}

async function rejectionMessage(operation: Promise<unknown>): Promise<string> {
  try {
    await operation
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error("Expected operation to reject")
}

describe("installPhysicsOceanPacks", () => {
  test("verifies, installs, reports, and preserves saved papers", async () => {
    const root = await temporaryRoot()
    const home = join(root, "home")
    const destination = join(home, "PhysicsOcean")
    await mkdir(join(destination, "arxiv"), { recursive: true })
    await writeFile(join(destination, "arxiv", "saved-paper.md"), "keep me")
    await writeFile(join(destination, "search.db-wal"), "stale wal")
    const database = await sqliteBuffer(root)
    const packPath = join(root, "physicsocean-textbooks-test.tar.gz")
    await createPack(packPath, [
      { header: { name: "book.tex", type: "file" }, body: "\\section{Mechanics}" },
      { header: { name: "search.db", type: "file" }, body: database },
      { header: { name: "books.md", type: "file" }, body: "# Books\n" },
      { header: { name: "books.json", type: "file" }, body: "[]\n" },
    ])
    await writeChecksum(packPath)

    const messages: string[] = []
    const result = await installPhysicsOceanPacks([packPath], {
      home,
      onProgress: (message) => messages.push(message),
    })

    expect(result.files).toEqual(["book.tex", "books.json", "books.md", "search.db"])
    expect(result.checksums[0]?.verified).toBe(true)
    expect(messages.some((message) => message.startsWith("Hashing "))).toBe(true)
    expect((await readFile(join(destination, "search.db"))).equals(database)).toBe(true)
    expect(await readFile(join(destination, "arxiv", "saved-paper.md"), "utf8")).toBe("keep me")
    expect(await exists(join(destination, "search.db-wal"))).toBe(false)

    const status = await getPhysicsOceanStatus(home)
    expect(status.textbookFiles).toBe(1)
    expect(status.searchDatabase?.sizeBytes).toBe(database.byteLength)
    expect(status.savedPapersDirectory).toBe(true)
    expect((await readdir(destination)).some((name) => name.startsWith(".sandbox-data-"))).toBe(false)
  })

  test("rejects a checksum mismatch before changing existing data", async () => {
    const root = await temporaryRoot()
    const home = join(root, "home")
    const destination = join(home, "PhysicsOcean")
    await mkdir(destination, { recursive: true })
    await writeFile(join(destination, "book.tex"), "original")
    const packPath = join(root, "physicsocean-textbooks-test.tar.gz")
    await createPack(packPath, [
      { header: { name: "book.tex", type: "file" }, body: "replacement" },
      { header: { name: "search.db", type: "file" }, body: await sqliteBuffer(root) },
    ])
    await writeChecksum(packPath, "0".repeat(64))

    expect(await rejectionMessage(installPhysicsOceanPacks([packPath], { home }))).toContain("Checksum mismatch")
    expect(await readFile(join(destination, "book.tex"), "utf8")).toBe("original")
  })

  test("requires a checksum unless explicitly allowed", async () => {
    const root = await temporaryRoot()
    const home = join(root, "home")
    const packPath = join(root, "physicsocean-textbooks-test.tar.gz")
    await createPack(packPath, [
      { header: { name: "book.tex", type: "file" }, body: "text" },
      { header: { name: "search.db", type: "file" }, body: await sqliteBuffer(root) },
    ])

    expect(await rejectionMessage(installPhysicsOceanPacks([packPath], { home }))).toContain(
      "Missing checksum sidecar",
    )
    const result = await installPhysicsOceanPacks([packPath], { home, allowUnverified: true })
    expect(result.checksums[0]?.verified).toBe(false)
  })

  test("rejects links and traversal paths", async () => {
    const root = await temporaryRoot()
    const database = await sqliteBuffer(root)
    const linkPack = join(root, "link.tar.gz")
    await createPack(linkPack, [
      { header: { name: "book.tex", type: "file" }, body: "text" },
      { header: { name: "search.db", type: "file" }, body: database },
      { header: { name: "escape.tex", type: "symlink", linkname: "../escape" } },
    ])
    await writeChecksum(linkPack)

    expect(
      await rejectionMessage(installPhysicsOceanPacks([linkPack], { home: join(root, "link-home") })),
    ).toContain("Unsupported archive entry type")

    const traversalPack = join(root, "traversal.tar.gz")
    await createPack(traversalPack, [
      { header: { name: "../escape.tex", type: "file" }, body: "escape" },
      { header: { name: "search.db", type: "file" }, body: database },
    ])
    await writeChecksum(traversalPack)
    expect(
      await rejectionMessage(installPhysicsOceanPacks([traversalPack], { home: join(root, "traversal-home") })),
    ).not.toBe("")
    expect(await exists(join(root, "escape.tex"))).toBe(false)
  })

  test("rejects duplicate names after portable case folding", async () => {
    const root = await temporaryRoot()
    const packPath = join(root, "duplicates.tar.gz")
    await createPack(packPath, [
      { header: { name: "Book.tex", type: "file" }, body: "one" },
      { header: { name: "book.tex", type: "file" }, body: "two" },
      { header: { name: "search.db", type: "file" }, body: await sqliteBuffer(root) },
    ])
    await writeChecksum(packPath)

    expect(
      await rejectionMessage(installPhysicsOceanPacks([packPath], { home: join(root, "home") })),
    ).toContain("Duplicate archive entry")
  })

  test("rolls back files replaced before a later install failure", async () => {
    const root = await temporaryRoot()
    const home = join(root, "home")
    const destination = join(home, "PhysicsOcean")
    await mkdir(join(destination, "books.md"), { recursive: true })
    await writeFile(join(destination, "alpha.tex"), "original")
    const packPath = join(root, "rollback.tar.gz")
    await createPack(packPath, [
      { header: { name: "alpha.tex", type: "file" }, body: "replacement" },
      { header: { name: "books.md", type: "file" }, body: "catalog" },
      { header: { name: "search.db", type: "file" }, body: await sqliteBuffer(root) },
    ])
    await writeChecksum(packPath)

    expect(await rejectionMessage(installPhysicsOceanPacks([packPath], { home }))).toContain(
      "Refusing to replace non-file",
    )
    expect(await readFile(join(destination, "alpha.tex"), "utf8")).toBe("original")
    expect((await lstat(join(destination, "books.md"))).isDirectory()).toBe(true)
    expect(await exists(join(destination, "search.db"))).toBe(false)
    expect((await readdir(destination)).some((name) => name.startsWith(".sandbox-data-"))).toBe(false)
  })
})
