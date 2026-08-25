import { afterEach, describe, expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import {
  buildLaunchEnvironment,
  resolveOpenCodeArguments,
  runCli,
  versionSatisfiesRange,
  type LaunchRequest,
  type PackageMetadata,
} from "../src/cli-core.js"
import type { DataInstallOptions, PhysicsOceanStatus } from "../src/data-installer.js"

const METADATA: PackageMetadata = {
  name: "@lightcone-boundary/sandbox",
  version: "0.2.0",
  nodeEngine: "^22.22.2 || ^24.15.0 || >=26",
  opencodeVersion: "1.18.22",
}

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sandbox-cli-"))
  temporaryRoots.push(root)
  return root
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

function emptyStatus(root: string): PhysicsOceanStatus {
  return {
    root,
    searchDatabase: null,
    arxivDatabase: null,
    booksMarkdown: null,
    booksJson: null,
    textbookFiles: 0,
    savedPapersDirectory: true,
  }
}

describe("buildLaunchEnvironment", () => {
  test("preserves user config while replacing prior SANDBOX plugin entries", () => {
    const originalContent = {
      plugin: [
        "existing-plugin",
        "@lightcone-boundary/sandbox@0.1.0",
        ["configured-plugin", { enabled: true }],
      ],
      mcp: { local: { enabled: false } },
      default_agent: "user-agent",
    }
    const base = {
      SANDBOX_HOME: "~/sandbox-test",
      OPENCODE_CONFIG_DIR: "/user/config",
      OPENCODE_CONFIG_CONTENT: JSON.stringify(originalContent),
    }

    const result = buildLaunchEnvironment(base, "/workspace", METADATA, "file:///package/dist/index.js")
    const config: {
      plugin: unknown[]
      mcp: unknown
      default_agent: string
    } = JSON.parse(result.OPENCODE_CONFIG_CONTENT!)

    expect(config.plugin).toEqual([
      "existing-plugin",
      ["configured-plugin", { enabled: true }],
      "file:///package/dist/index.js",
    ])
    expect(config.mcp).toEqual(originalContent.mcp)
    expect(config.default_agent).toBe("sandbox-physics")
    expect(result.OPENCODE_CONFIG_DIR).toBe("/user/config")
    expect(result.SANDBOX_ENABLED).toBe("1")
    expect(result.SANDBOX_LAUNCH_DIR).toBe("/workspace")
    expect(originalContent.plugin).toHaveLength(3)
  })
})

describe("OpenCode routing", () => {
  test("maps product shortcuts without rewriting ordinary OpenCode commands", () => {
    expect(resolveOpenCodeArguments([])).toEqual(["web"])
    expect(resolveOpenCodeArguments(["--port", "4096"])).toEqual(["web", "--port", "4096"])
    expect(resolveOpenCodeArguments(["tui", "--continue"])).toEqual(["--continue"])
    expect(resolveOpenCodeArguments(["run", "derive the Euler-Lagrange equation"])).toEqual([
      "run",
      "derive the Euler-Lagrange equation",
    ])
  })

  test("launches default web mode with child-only SANDBOX configuration", async () => {
    const root = await temporaryRoot()
    let request: LaunchRequest | undefined
    const code = await runCli([], {
      packageMetadata: METADATA,
      pluginSpecifier: "file:///package/dist/index.js",
      cwd: root,
      env: { SANDBOX_HOME: join(root, "home") },
      launch: async (value) => {
        request = value
        return 7
      },
    })

    expect(code).toBe(7)
    expect(request?.command).toBe("opencode")
    expect(request?.args).toEqual(["web"])
    const config: { default_agent: string; plugin: string[] } = JSON.parse(
      request?.env.OPENCODE_CONFIG_CONTENT ?? "{}",
    )
    expect(config.default_agent).toBe("sandbox-physics")
    expect(config.plugin).toEqual(["file:///package/dist/index.js"])
  })

  test("rejects malformed inline config before launching", async () => {
    let launched = false
    const errors: string[] = []
    const code = await runCli([], {
      packageMetadata: METADATA,
      env: { OPENCODE_CONFIG_CONTENT: "{" },
      stderr: (message) => errors.push(message),
      launch: async () => {
        launched = true
        return 0
      },
    })

    expect(code).toBe(2)
    expect(launched).toBe(false)
    expect(errors).toEqual(["sandbox: OPENCODE_CONFIG_CONTENT is not valid JSON"])
  })
})

describe("native CLI commands", () => {
  test("setup creates only runtime data directories", async () => {
    const root = await temporaryRoot()
    const home = join(root, "home")
    const output: string[] = []
    const code = await runCli(["setup", "--home", home], {
      packageMetadata: METADATA,
      env: {},
      stdout: (message) => output.push(message),
    })

    expect(code).toBe(0)
    expect(await exists(join(home, "shared", "research"))).toBe(true)
    expect(await exists(join(home, "artifacts"))).toBe(true)
    expect(await exists(join(home, "PhysicsOcean", "arxiv"))).toBe(true)
    expect(await exists(join(home, "opencode.json"))).toBe(false)
    expect(output.join("\n")).toContain("No global OpenCode configuration was modified")
  })

  test("data install forwards repeated and positional packs", async () => {
    const root = await temporaryRoot()
    const home = join(root, "home")
    let captured: { packs: string[]; options: DataInstallOptions } | undefined
    const output: string[] = []
    const code = await runCli(
      [
        "data",
        "install",
        "--from",
        "textbooks.tar.gz",
        "arxiv.tar.gz",
        "--home",
        home,
        "--allow-unverified",
        "--json",
      ],
      {
        packageMetadata: METADATA,
        env: {},
        stdout: (message) => output.push(message),
        installPacks: async (packs, options) => {
          captured = { packs, options: options ?? {} }
          return {
            root: join(home, "PhysicsOcean"),
            files: ["search.db", "arxiv_meta.db"],
            expandedBytes: 2048,
            checksums: [],
          }
        },
      },
    )

    expect(code).toBe(0)
    expect(captured?.packs).toEqual(["textbooks.tar.gz", "arxiv.tar.gz"])
    expect(captured?.options.home).toBe(home)
    expect(captured?.options.allowUnverified).toBe(true)
    expect(captured?.options.onProgress).toBeUndefined()
    expect(JSON.parse(output[0]!).files).toEqual(["search.db", "arxiv_meta.db"])
  })

  test("doctor treats optional data as warnings but runtime failures as errors", async () => {
    const root = await temporaryRoot()
    const home = join(root, "home")
    const plugin = join(root, "index.js")
    await mkdir(home, { recursive: true })
    await writeFile(plugin, "export default {}\n")
    const output: string[] = []

    const healthy = await runCli(["doctor", "--home", home, "--json"], {
      packageMetadata: METADATA,
      pluginSpecifier: pathToFileURL(plugin).href,
      nodeVersion: "22.22.2",
      env: {},
      cwd: root,
      stdout: (message) => output.push(message),
      probe: async () => ({ code: 0, stdout: "1.18.22\n", stderr: "" }),
      dataStatus: async () => emptyStatus(join(home, "PhysicsOcean")),
    })

    expect(healthy).toBe(0)
    const report: { checks: Array<{ name: string; status: string }> } = JSON.parse(output[0]!)
    expect(report.checks.find((check) => check.name === "PhysicsOcean textbooks")?.status).toBe("warn")

    const errors: string[] = []
    const unhealthy = await runCli(["doctor", "--home", home], {
      packageMetadata: METADATA,
      pluginSpecifier: pathToFileURL(plugin).href,
      nodeVersion: "20.20.0",
      env: {},
      cwd: root,
      stdout: (message) => errors.push(message),
      probe: async () => ({ code: 127, stdout: "", stderr: "command not found" }),
      dataStatus: async () => emptyStatus(join(home, "PhysicsOcean")),
    })

    expect(unhealthy).toBe(1)
    expect(errors.some((line) => line.startsWith("FAIL  Node.js"))).toBe(true)
    expect(errors.some((line) => line.startsWith("FAIL  OpenCode"))).toBe(true)
  })
})

describe("versionSatisfiesRange", () => {
  test("supports the package's LTS engine alternatives", () => {
    const range = METADATA.nodeEngine
    expect(versionSatisfiesRange("22.22.2", range)).toBe(true)
    expect(versionSatisfiesRange("22.21.9", range)).toBe(false)
    expect(versionSatisfiesRange("23.0.0", range)).toBe(false)
    expect(versionSatisfiesRange("24.15.0", range)).toBe(true)
    expect(versionSatisfiesRange("26.0.0", range)).toBe(true)
  })
})
