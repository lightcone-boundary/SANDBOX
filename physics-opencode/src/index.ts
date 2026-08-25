import type { Config, Hooks, PluginModule } from "@opencode-ai/plugin"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { basename, dirname, extname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { physicsTools } from "./physics-tools.js"

type PhysicsAgentConfig = {
  description?: string
  mode?: "primary" | "subagent" | "all"
  model?: string
  temperature?: number
  steps?: number
  hidden?: boolean
  permission?: Record<string, string>
  prompt: string
}

const currentDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(currentDir, "..")
const bundledAgentDir = resolve(currentDir, "assets", "agents")
const sourceAgentDir = resolve(packageRoot, "..", ".opencode", "agents")
const agentDir = existsSync(bundledAgentDir) ? bundledAgentDir : sourceAgentDir

function unquote(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "")
}

function parseScalar(value: string): string | number | boolean {
  const trimmed = value.trim()
  if (trimmed === "true") return true
  if (trimmed === "false") return false
  const numeric = Number(trimmed)
  if (trimmed !== "" && Number.isFinite(numeric)) return numeric
  return unquote(trimmed)
}

function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!raw.startsWith("---\n")) return { frontmatter: {}, body: raw }

  const end = raw.indexOf("\n---\n", 4)
  if (end === -1) return { frontmatter: {}, body: raw }

  const frontmatterText = raw.slice(4, end)
  const body = raw.slice(end + "\n---\n".length)
  const frontmatter: Record<string, unknown> = {}
  let currentMapKey: string | undefined

  for (const line of frontmatterText.split("\n")) {
    if (!line.trim()) continue

    const nested = line.match(/^\s+([^:]+):\s*(.+)$/)
    if (nested && currentMapKey) {
      const container = frontmatter[currentMapKey]
      if (container && typeof container === "object" && !Array.isArray(container)) {
        ;(container as Record<string, unknown>)[unquote(nested[1])] = parseScalar(nested[2])
      }
      continue
    }

    const top = line.match(/^([^:]+):\s*(.*)$/)
    if (!top) continue

    const key = unquote(top[1])
    const value = top[2]
    if (value.trim() === "") {
      const map: Record<string, unknown> = {}
      frontmatter[key] = map
      currentMapKey = key
    } else {
      frontmatter[key] = parseScalar(value)
      currentMapKey = undefined
    }
  }

  return { frontmatter, body }
}

function loadAgent(fileName: string): PhysicsAgentConfig {
  const raw = readFileSync(resolve(agentDir, fileName), "utf8")
  const { frontmatter, body } = parseFrontmatter(raw)
  const steps = frontmatter.steps

  return {
    description: typeof frontmatter.description === "string" ? frontmatter.description : undefined,
    mode: frontmatter.mode === "primary" || frontmatter.mode === "subagent" || frontmatter.mode === "all"
      ? frontmatter.mode
      : undefined,
    model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
    temperature: typeof frontmatter.temperature === "number" ? frontmatter.temperature : undefined,
    steps: typeof steps === "number" ? steps : undefined,
    hidden: typeof frontmatter.hidden === "boolean" ? frontmatter.hidden : undefined,
    permission: frontmatter.permission && typeof frontmatter.permission === "object" && !Array.isArray(frontmatter.permission)
      ? frontmatter.permission as Record<string, string>
      : undefined,
    prompt: body.trim(),
  }
}

function physicsAgents() {
  const agents = Object.fromEntries(
    readdirSync(agentDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && extname(entry.name) === ".md")
      .map((entry) => [basename(entry.name, ".md"), loadAgent(entry.name)]),
  )

  return {
    ...agents,
    build: { disable: true, hidden: true },
    plan: { disable: true, hidden: true },
  }
}

export function createPhysicsHooks(enabled = process.env.SANDBOX_ENABLED !== "0"): Hooks {
  if (!enabled) return {}

  return {
    tool: physicsTools,
    async config(config: Config) {
      config.agent = {
        ...(config.agent ?? {}),
        ...physicsAgents(),
      }
    },
  }
}

const pluginModule: PluginModule = {
  id: "sandbox-physics",
  async server() {
    return createPhysicsHooks()
  },
}

export default pluginModule
