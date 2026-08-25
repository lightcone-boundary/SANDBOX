import { homedir } from "node:os"
import { join, resolve } from "node:path"

export function expandUserPath(value: string): string {
  const trimmed = value.trim()
  if (trimmed === "~") return homedir()
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return join(homedir(), trimmed.slice(2))
  }
  return resolve(trimmed)
}

export function sandboxHome(override?: string): string {
  const configured = override?.trim() || process.env.SANDBOX_HOME?.trim()
  return configured ? expandUserPath(configured) : join(homedir(), "sandbox")
}

export function physicsOceanRoot(home = sandboxHome()): string {
  return join(home, "PhysicsOcean")
}

export function physicsOceanSearchDb(home = sandboxHome()): string {
  return join(physicsOceanRoot(home), "search.db")
}

export function arxivMetadataDb(home = sandboxHome()): string {
  return join(physicsOceanRoot(home), "arxiv_meta.db")
}

export function arxivPaperRoot(home = sandboxHome()): string {
  return join(physicsOceanRoot(home), "arxiv")
}

export function runtimeDb(home = sandboxHome()): string {
  return join(home, "shared", "sandbox-runtime.db")
}
