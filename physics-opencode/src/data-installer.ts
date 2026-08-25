import { createHash } from "node:crypto"
import { createReadStream, type Stats } from "node:fs"
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises"
import { basename, join } from "node:path"
import { extract, list, type ReadEntry } from "tar"

import { expandUserPath, physicsOceanRoot, sandboxHome } from "./paths.js"

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "ascii")
const MAX_PACK_BYTES = 16 * 1024 ** 3
const MAX_EXPANDED_BYTES = 48 * 1024 ** 3
const MAX_ARCHIVE_FILES = 10_000
const MAX_TEX_BYTES = 256 * 1024 ** 2
const MAX_CATALOG_BYTES = 128 * 1024 ** 2
const MAX_DATABASE_BYTES = 32 * 1024 ** 3
const FIXED_FILES = new Set(["search.db", "arxiv_meta.db", "books.md", "books.json"])

export interface DataInstallOptions {
  home?: string
  allowUnverified?: boolean
  onProgress?: (message: string) => void
}

export interface PackChecksum {
  pack: string
  sha256: string
  verified: boolean
}

export interface DataInstallResult {
  root: string
  files: string[]
  expandedBytes: number
  checksums: PackChecksum[]
}

export interface InstalledDataFile {
  path: string
  sizeBytes: number
  modifiedAt: string
}

export interface PhysicsOceanStatus {
  root: string
  searchDatabase: InstalledDataFile | null
  arxivDatabase: InstalledDataFile | null
  booksMarkdown: InstalledDataFile | null
  booksJson: InstalledDataFile | null
  textbookFiles: number
  savedPapersDirectory: boolean
}

interface ArchiveFile {
  name: string
  size: number
}

interface InspectedPack {
  path: string
  files: ArchiveFile[]
  checksum: PackChecksum
}

function nodeErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined
  const code = error.code
  return typeof code === "string" ? code : undefined
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

async function maybeLstat(path: string): Promise<Stats | null> {
  try {
    return await lstat(path)
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return null
    throw error
  }
}

function normalizeArchiveName(raw: string): string {
  if (!raw || raw.includes("\\") || raw.includes("\0")) {
    throw new Error(`Unsafe archive path: ${JSON.stringify(raw)}`)
  }

  let name = raw
  while (name.startsWith("./")) name = name.slice(2)
  if (!name || name.startsWith("/") || name.includes("/") || name === "." || name === "..") {
    throw new Error(`PhysicsOcean packs must contain flat file paths: ${JSON.stringify(raw)}`)
  }
  if (/^[a-zA-Z]:/.test(name) || /[<>:"|?*\u0000-\u001f]/u.test(name)) {
    throw new Error(`Archive path is not portable to Windows: ${JSON.stringify(raw)}`)
  }
  if (name.endsWith(".") || name.endsWith(" ")) {
    throw new Error(`Archive path has an unsafe trailing character: ${JSON.stringify(raw)}`)
  }

  const stem = name.split(".", 1)[0]?.toUpperCase()
  if (stem && /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
    throw new Error(`Archive path uses a Windows reserved name: ${JSON.stringify(raw)}`)
  }

  const normalized = name.normalize("NFC")
  if (!FIXED_FILES.has(normalized) && !normalized.toLowerCase().endsWith(".tex")) {
    throw new Error(`Unexpected file in PhysicsOcean pack: ${JSON.stringify(raw)}`)
  }
  return normalized
}

function maximumFileSize(name: string): number {
  if (name.endsWith(".db")) return MAX_DATABASE_BYTES
  if (name.toLowerCase().endsWith(".tex")) return MAX_TEX_BYTES
  return MAX_CATALOG_BYTES
}

function validateArchiveEntry(path: string, entry: ReadEntry): ArchiveFile {
  const name = normalizeArchiveName(path)
  if (entry.type !== "File" && entry.type !== "OldFile") {
    throw new Error(`Unsupported archive entry type for ${name}: ${entry.type}`)
  }
  if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > maximumFileSize(name)) {
    throw new Error(`Archive entry ${name} has an invalid size: ${entry.size}`)
  }
  return { name, size: entry.size }
}

async function sha256(path: string): Promise<string> {
  const digest = createHash("sha256")
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest("hex")
}

async function expectedChecksum(pack: string): Promise<string | null> {
  const sidecar = `${pack}.sha256`
  const metadata = await maybeLstat(sidecar)
  if (!metadata) return null
  if (!metadata.isFile() || metadata.size > 4096) {
    throw new Error(`Invalid checksum sidecar: ${sidecar}`)
  }

  const firstLine = (await readFile(sidecar, "utf8")).split(/\r?\n/u).find((line) => line.trim())
  const match = firstLine?.trim().match(/^([a-fA-F0-9]{64})(?:\s+\*?(.+))?$/u)
  if (!match) throw new Error(`Invalid SHA-256 content in ${sidecar}`)
  const declaredName = match[2]?.trim()
  if (declaredName && basename(declaredName) !== basename(pack)) {
    throw new Error(`Checksum sidecar names ${declaredName}, not ${basename(pack)}`)
  }
  return match[1]!.toLowerCase()
}

async function inspectPack(
  input: string,
  allowUnverified: boolean,
  onProgress: (message: string) => void,
): Promise<InspectedPack> {
  const pack = expandUserPath(input)
  const metadata = await maybeLstat(pack)
  if (!metadata?.isFile()) throw new Error(`PhysicsOcean pack not found: ${pack}`)
  if (metadata.size <= 0 || metadata.size > MAX_PACK_BYTES) {
    throw new Error(`PhysicsOcean pack has an invalid size: ${pack}`)
  }

  onProgress(`Hashing ${basename(pack)}...`)
  const [actual, expected] = await Promise.all([sha256(pack), expectedChecksum(pack)])
  if (!expected && !allowUnverified) {
    throw new Error(`Missing checksum sidecar: ${pack}.sha256`)
  }
  if (expected && actual !== expected) {
    throw new Error(`Checksum mismatch for ${basename(pack)}: expected ${expected}, received ${actual}`)
  }

  const files: ArchiveFile[] = []
  const seen = new Set<string>()
  const inspection = { error: null as Error | null }
  let expandedBytes = 0
  onProgress(`Inspecting ${basename(pack)}...`)
  await list({
    file: pack,
    strict: true,
    maxDecompressionRatio: 1_000,
    onReadEntry(entry) {
      if (inspection.error) return
      try {
        const file = validateArchiveEntry(entry.path, entry)
        const key = file.name.normalize("NFC").toLocaleLowerCase("en-US")
        if (seen.has(key)) throw new Error(`Duplicate archive entry: ${file.name}`)
        seen.add(key)
        files.push(file)
        expandedBytes += file.size
        if (files.length > MAX_ARCHIVE_FILES || expandedBytes > MAX_EXPANDED_BYTES) {
          throw new Error(`PhysicsOcean pack expands beyond the supported limit: ${pack}`)
        }
      } catch (error) {
        inspection.error = toError(error)
      }
    },
  })
  if (inspection.error) throw inspection.error

  if (!files.length) throw new Error(`PhysicsOcean pack is empty: ${pack}`)
  const names = new Set(files.map((file) => file.name))
  if (!names.has("search.db") && !names.has("arxiv_meta.db")) {
    throw new Error(`PhysicsOcean pack contains neither search.db nor arxiv_meta.db: ${pack}`)
  }
  if (names.has("search.db") && !files.some((file) => file.name.toLowerCase().endsWith(".tex"))) {
    throw new Error(`Textbook pack contains search.db but no .tex files: ${pack}`)
  }

  return {
    path: pack,
    files,
    checksum: { pack, sha256: actual, verified: expected !== null },
  }
}

async function validateExtractedFile(path: string, file: ArchiveFile): Promise<void> {
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.size !== file.size) {
    throw new Error(`Extracted file does not match its archive entry: ${file.name}`)
  }
  if (!file.name.endsWith(".db")) return

  const handle = await open(path, "r")
  try {
    const header = Buffer.alloc(SQLITE_HEADER.length)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    if (bytesRead !== header.length || !header.equals(SQLITE_HEADER)) {
      throw new Error(`Extracted database is not SQLite: ${file.name}`)
    }
  } finally {
    await handle.close()
  }
}

async function replaceInstalledFiles(stage: string, destination: string, names: string[]): Promise<void> {
  const backup = await mkdtemp(join(destination, ".sandbox-data-backup-"))
  const movedExisting: string[] = []
  const installed: string[] = []

  try {
    for (const name of names) {
      const target = join(destination, name)
      const existing = await maybeLstat(target)
      if (existing) {
        if (!existing.isFile()) throw new Error(`Refusing to replace non-file data path: ${target}`)
        await rename(target, join(backup, name))
        movedExisting.push(name)
      }

      await rename(join(stage, name), target)
      installed.push(name)

      if (name.endsWith(".db")) {
        for (const suffix of ["-wal", "-shm"]) {
          const sidecarName = `${name}${suffix}`
          const sidecar = join(destination, sidecarName)
          const sidecarMetadata = await maybeLstat(sidecar)
          if (!sidecarMetadata) continue
          if (!sidecarMetadata.isFile()) {
            throw new Error(`Refusing to replace non-file SQLite sidecar: ${sidecar}`)
          }
          await rename(sidecar, join(backup, sidecarName))
          movedExisting.push(sidecarName)
        }
      }
    }
  } catch (error) {
    const rollbackErrors: unknown[] = []
    for (const name of installed.reverse()) {
      try {
        await rm(join(destination, name), { force: true })
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    for (const name of movedExisting.reverse()) {
      try {
        await rename(join(backup, name), join(destination, name))
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (rollbackErrors.length) {
      throw new AggregateError([error, ...rollbackErrors], "PhysicsOcean install and rollback both failed")
    }
    throw error
  } finally {
    await rm(backup, { recursive: true, force: true })
  }
}

export async function installPhysicsOceanPacks(
  inputs: string[],
  options: DataInstallOptions = {},
): Promise<DataInstallResult> {
  if (!inputs.length) throw new Error("At least one PhysicsOcean pack is required")
  const onProgress = options.onProgress ?? (() => undefined)
  const inspected = await Promise.all(
    inputs.map((input) => inspectPack(input, options.allowUnverified === true, onProgress)),
  )

  const files = new Map<string, ArchiveFile>()
  for (const pack of inspected) {
    for (const file of pack.files) {
      const key = file.name.normalize("NFC").toLocaleLowerCase("en-US")
      if (files.has(key)) throw new Error(`Multiple packs contain ${file.name}`)
      files.set(key, file)
    }
  }

  const home = sandboxHome(options.home)
  const destination = physicsOceanRoot(home)
  await mkdir(destination, { recursive: true })
  const stage = await mkdtemp(join(destination, ".sandbox-data-stage-"))

  try {
    for (const pack of inspected) {
      const allowed = new Map(
        pack.files.map((file) => [file.name.normalize("NFC").toLocaleLowerCase("en-US"), file]),
      )
      const extraction = { error: null as Error | null }
      onProgress(`Extracting ${basename(pack.path)}...`)
      await extract({
        file: pack.path,
        cwd: stage,
        strict: true,
        preserveOwner: false,
        preservePaths: false,
        unlink: true,
        maxDepth: 1,
        maxDecompressionRatio: 1_000,
        filter(path, entry) {
          if (extraction.error) return false
          try {
            if (!("type" in entry)) throw new Error(`Missing tar metadata for ${path}`)
            const file = validateArchiveEntry(path, entry)
            const expected = allowed.get(file.name.normalize("NFC").toLocaleLowerCase("en-US"))
            if (expected?.size !== file.size) {
              throw new Error(`Archive changed during installation: ${basename(pack.path)}`)
            }
            return true
          } catch (error) {
            extraction.error = toError(error)
            return false
          }
        },
      })
      if (extraction.error) throw extraction.error
    }

    const extracted = [...files.values()]
    for (const file of extracted) await validateExtractedFile(join(stage, file.name), file)
    const names = extracted.map((file) => file.name).sort((left, right) => left.localeCompare(right))
    onProgress(`Installing ${names.length} PhysicsOcean file(s)...`)
    await replaceInstalledFiles(stage, destination, names)

    return {
      root: destination,
      files: names,
      expandedBytes: extracted.reduce((total, file) => total + file.size, 0),
      checksums: inspected.map((pack) => pack.checksum),
    }
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

async function installedFile(path: string): Promise<InstalledDataFile | null> {
  const metadata = await maybeLstat(path)
  if (!metadata?.isFile()) return null
  return { path, sizeBytes: metadata.size, modifiedAt: metadata.mtime.toISOString() }
}

export async function getPhysicsOceanStatus(homeOverride?: string): Promise<PhysicsOceanStatus> {
  const root = physicsOceanRoot(sandboxHome(homeOverride))
  const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if (nodeErrorCode(error) === "ENOENT") return []
    throw error
  })

  const [searchDatabase, arxivDatabase, booksMarkdown, booksJson] = await Promise.all([
    installedFile(join(root, "search.db")),
    installedFile(join(root, "arxiv_meta.db")),
    installedFile(join(root, "books.md")),
    installedFile(join(root, "books.json")),
  ])

  return {
    root,
    searchDatabase,
    arxivDatabase,
    booksMarkdown,
    booksJson,
    textbookFiles: entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".tex")).length,
    savedPapersDirectory: entries.some((entry) => entry.isDirectory() && entry.name === "arxiv"),
  }
}
