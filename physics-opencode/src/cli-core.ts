import spawn from "cross-spawn"
import type { ChildProcess, SpawnOptions } from "node:child_process"
import { constants as fsConstants } from "node:fs"
import { access, mkdir, readFile } from "node:fs/promises"
import { constants as osConstants } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  getPhysicsOceanStatus,
  installPhysicsOceanPacks,
  type PhysicsOceanStatus,
} from "./data-installer.js"
import { physicsOceanRoot, sandboxHome } from "./paths.js"

const moduleDirectory = dirname(fileURLToPath(import.meta.url))
const packageJsonPath = join(moduleDirectory, "..", "package.json")

export const DEFAULT_PLUGIN_SPECIFIER = new URL("./index.js", import.meta.url).href

const HELP = `SANDBOX Physics

Usage:
  sandbox                         Start the OpenCode web interface
  sandbox [web options]           Start web mode with options such as --port
  sandbox tui [options]           Start the OpenCode terminal interface
  sandbox <opencode command> ...  Run an OpenCode command with SANDBOX enabled
  sandbox setup [--home PATH]     Create the SANDBOX data directories
  sandbox data install [PACK ...] [--from PACK] [--home PATH]
  sandbox data status [--home PATH] [--json]
  sandbox doctor [--home PATH] [--json]

Data installation verifies a sibling PACK.sha256 file by default. Use
--allow-unverified only for packs you created and trust locally.`

const DATA_HELP = `Usage:
  sandbox data install PACK [PACK ...] [--from PACK] [--home PATH]
  sandbox data status [--home PATH] [--json]`

export interface PackageMetadata {
  name: string
  version: string
  nodeEngine: string
  opencodeVersion: string
}

export interface LaunchRequest {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

export interface ProcessResult {
  code: number
  stdout: string
  stderr: string
}

export type LaunchCommand = (request: LaunchRequest) => Promise<number>
export type ProbeCommand = (request: LaunchRequest) => Promise<ProcessResult>

export interface CliDependencies {
  env?: NodeJS.ProcessEnv
  cwd?: string
  nodeVersion?: string
  pluginSpecifier?: string
  packageMetadata?: PackageMetadata
  stdout?: (message: string) => void
  stderr?: (message: string) => void
  launch?: LaunchCommand
  probe?: ProbeCommand
  installPacks?: typeof installPhysicsOceanPacks
  dataStatus?: typeof getPhysicsOceanStatus
}

interface ParsedOptions {
  home?: string
  json: boolean
  allowUnverified: boolean
  from: string[]
  positionals: string[]
  help: boolean
}

interface OptionPolicy {
  home?: boolean
  json?: boolean
  allowUnverified?: boolean
  from?: boolean
  positionals?: boolean
}

interface DoctorCheck {
  name: string
  status: "pass" | "warn" | "fail"
  detail: string
}

class UsageError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined
  return typeof error.code === "string" ? error.code : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function requiredString(record: Record<string, unknown>, key: string, source: string): string {
  const value = record[key]
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${source} is missing a valid ${key}`)
  }
  return value
}

export async function readPackageMetadata(path = packageJsonPath): Promise<PackageMetadata> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
  if (!isRecord(parsed)) throw new Error(`Invalid package metadata: ${path}`)
  const engines = parsed.engines
  const dependencies = parsed.dependencies
  if (!isRecord(engines) || !isRecord(dependencies)) {
    throw new Error(`Package metadata is missing engines or dependencies: ${path}`)
  }
  return {
    name: requiredString(parsed, "name", path),
    version: requiredString(parsed, "version", path),
    nodeEngine: requiredString(engines, "node", path),
    opencodeVersion: requiredString(dependencies, "@opencode-ai/plugin", path),
  }
}

function parseVersion(value: string): [number, number, number] | null {
  const match = value.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+][0-9A-Za-z.-]+)?$/u)
  if (!match) return null
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)]
}

function compareVersions(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index]! - right[index]!
    if (difference !== 0) return difference
  }
  return 0
}

export function versionSatisfiesRange(version: string, range: string): boolean {
  const candidate = parseVersion(version)
  if (!candidate) return false
  return range.split("||").some((rawAlternative) => {
    const alternative = rawAlternative.trim()
    if (alternative.startsWith("^")) {
      const minimum = parseVersion(alternative.slice(1))
      return minimum !== null && candidate[0] === minimum[0] && compareVersions(candidate, minimum) >= 0
    }
    if (alternative.startsWith(">=")) {
      const minimum = parseVersion(alternative.slice(2))
      return minimum !== null && compareVersions(candidate, minimum) >= 0
    }
    const exact = parseVersion(alternative)
    return exact !== null && compareVersions(candidate, exact) === 0
  })
}

function versionAtLeast(version: string, minimum: string): boolean {
  const candidate = parseVersion(version)
  const required = parseVersion(minimum)
  return candidate !== null && required !== null && compareVersions(candidate, required) >= 0
}

function readOptionValue(args: string[], index: number, name: string): { value: string; next: number } {
  const argument = args[index]!
  const prefix = `${name}=`
  if (argument.startsWith(prefix)) {
    const value = argument.slice(prefix.length)
    if (!value) throw new UsageError(`${name} requires a value`)
    return { value, next: index }
  }
  const value = args[index + 1]
  if (!value || value.startsWith("-")) throw new UsageError(`${name} requires a value`)
  return { value, next: index + 1 }
}

function parseOptions(args: string[], policy: OptionPolicy): ParsedOptions {
  const parsed: ParsedOptions = {
    json: false,
    allowUnverified: false,
    from: [],
    positionals: [],
    help: false,
  }

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (argument === "--help" || argument === "-h") {
      parsed.help = true
      continue
    }
    if (argument === "--json") {
      if (!policy.json) throw new UsageError(`Unknown option: ${argument}`)
      parsed.json = true
      continue
    }
    if (argument === "--allow-unverified") {
      if (!policy.allowUnverified) throw new UsageError(`Unknown option: ${argument}`)
      parsed.allowUnverified = true
      continue
    }
    if (argument === "--home" || argument.startsWith("--home=")) {
      if (!policy.home) throw new UsageError(`Unknown option: ${argument}`)
      const option = readOptionValue(args, index, "--home")
      parsed.home = option.value
      index = option.next
      continue
    }
    if (argument === "--from" || argument.startsWith("--from=")) {
      if (!policy.from) throw new UsageError(`Unknown option: ${argument}`)
      const option = readOptionValue(args, index, "--from")
      parsed.from.push(option.value)
      index = option.next
      continue
    }
    if (argument.startsWith("-")) throw new UsageError(`Unknown option: ${argument}`)
    if (!policy.positionals) throw new UsageError(`Unexpected argument: ${argument}`)
    parsed.positionals.push(argument)
  }

  return parsed
}

function sandboxPluginName(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry
  if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0]
  return undefined
}

function isSameSandboxPlugin(entry: unknown, packageName: string, pluginSpecifier: string): boolean {
  const name = sandboxPluginName(entry)
  return name === pluginSpecifier || name === packageName || name?.startsWith(`${packageName}@`) === true
}

export function buildLaunchEnvironment(
  base: NodeJS.ProcessEnv,
  cwd: string,
  metadata: PackageMetadata,
  pluginSpecifier = DEFAULT_PLUGIN_SPECIFIER,
): NodeJS.ProcessEnv {
  let inlineConfig: Record<string, unknown> = {}
  const existingContent = base.OPENCODE_CONFIG_CONTENT?.trim()
  if (existingContent) {
    let parsed: unknown
    try {
      parsed = JSON.parse(existingContent)
    } catch {
      throw new UsageError("OPENCODE_CONFIG_CONTENT is not valid JSON")
    }
    if (!isRecord(parsed)) throw new UsageError("OPENCODE_CONFIG_CONTENT must contain a JSON object")
    inlineConfig = parsed
  }

  const configuredPlugins = inlineConfig.plugin
  if (configuredPlugins !== undefined && !Array.isArray(configuredPlugins)) {
    throw new UsageError("OPENCODE_CONFIG_CONTENT.plugin must be an array")
  }
  const plugins = (configuredPlugins ?? []).filter(
    (entry) => !isSameSandboxPlugin(entry, metadata.name, pluginSpecifier),
  )
  plugins.push(pluginSpecifier)

  const home = sandboxHome(base.SANDBOX_HOME)
  return {
    ...base,
    SANDBOX_HOME: home,
    SANDBOX_ENABLED: "1",
    SANDBOX_LAUNCH_DIR: base.SANDBOX_LAUNCH_DIR?.trim() || cwd,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...inlineConfig,
      plugin: plugins,
      default_agent: "sandbox-physics",
    }),
  }
}

export function resolveOpenCodeArguments(args: string[]): string[] {
  if (!args.length) return ["web"]
  if (args[0] === "tui") return args.slice(1)
  if (args[0]!.startsWith("-")) return ["web", ...args]
  return [...args]
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (!signal) return 1
  return 128 + (osConstants.signals[signal] ?? 1)
}

function waitForChild(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code, signal) => resolve(code ?? signalExitCode(signal)))
  })
}

export async function launchProcess(request: LaunchRequest): Promise<number> {
  const options: SpawnOptions = {
    cwd: request.cwd,
    env: request.env,
    stdio: "inherit",
    windowsHide: false,
  }
  return waitForChild(spawn(request.command, request.args, options))
}

export async function probeProcess(request: LaunchRequest): Promise<ProcessResult> {
  const options: SpawnOptions = {
    cwd: request.cwd,
    env: request.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }
  const child = spawn(request.command, request.args, options)
  let stdout = ""
  let stderr = ""
  child.stdout?.on("data", (chunk: Buffer | string) => {
    stdout += String(chunk)
  })
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += String(chunk)
  })

  return new Promise((resolve) => {
    let settled = false
    const finish = (result: ProcessResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    child.once("error", (error) => finish({ code: 127, stdout, stderr: errorMessage(error) }))
    child.once("close", (code, signal) => {
      finish({ code: code ?? signalExitCode(signal), stdout, stderr })
    })
  })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KiB", "MiB", "GiB", "TiB"]
  let value = bytes / 1024
  let unit = units[0]!
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024
    unit = units[index]!
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`
}

async function setupCommand(
  args: string[],
  env: NodeJS.ProcessEnv,
  write: (message: string) => void,
): Promise<number> {
  const options = parseOptions(args, { home: true, json: true })
  if (options.help) {
    write("Usage: sandbox setup [--home PATH] [--json]")
    return 0
  }
  const home = sandboxHome(options.home ?? env.SANDBOX_HOME)
  const directories = [
    join(home, "shared", "research"),
    join(home, "artifacts"),
    join(physicsOceanRoot(home), "arxiv"),
  ]
  await Promise.all(directories.map((directory) => mkdir(directory, { recursive: true })))
  if (options.json) {
    write(JSON.stringify({ home, directories }, null, 2))
  } else {
    write(`SANDBOX home is ready: ${home}`)
    for (const directory of directories) write(`  ${directory}`)
    write("No global OpenCode configuration was modified. Run `sandbox doctor` to verify the runtime.")
  }
  return 0
}

async function dataInstallCommand(
  args: string[],
  env: NodeJS.ProcessEnv,
  write: (message: string) => void,
  install: typeof installPhysicsOceanPacks,
): Promise<number> {
  const options = parseOptions(args, {
    home: true,
    json: true,
    allowUnverified: true,
    from: true,
    positionals: true,
  })
  if (options.help) {
    write("Usage: sandbox data install PACK [PACK ...] [--from PACK] [--home PATH] [--allow-unverified] [--json]")
    return 0
  }
  const packs = [...options.from, ...options.positionals]
  if (!packs.length) throw new UsageError("data install requires at least one pack path")
  const result = await install(packs, {
    home: options.home ?? env.SANDBOX_HOME,
    allowUnverified: options.allowUnverified,
    onProgress: options.json ? undefined : write,
  })
  if (options.json) write(JSON.stringify(result, null, 2))
  else {
    write(`Installed ${result.files.length} file(s) into ${result.root} (${formatBytes(result.expandedBytes)}).`)
    for (const checksum of result.checksums) {
      write(`  ${checksum.verified ? "verified" : "unverified"}: ${checksum.pack}`)
    }
  }
  return 0
}

function statusSummary(status: PhysicsOceanStatus): string[] {
  return [
    `PhysicsOcean: ${status.root}`,
    `  textbooks: ${status.textbookFiles}`,
    `  search.db: ${status.searchDatabase ? formatBytes(status.searchDatabase.sizeBytes) : "missing"}`,
    `  arxiv_meta.db: ${status.arxivDatabase ? formatBytes(status.arxivDatabase.sizeBytes) : "missing"}`,
    `  saved papers: ${status.savedPapersDirectory ? "ready" : "directory missing"}`,
  ]
}

async function dataStatusCommand(
  args: string[],
  env: NodeJS.ProcessEnv,
  write: (message: string) => void,
  statusReader: typeof getPhysicsOceanStatus,
): Promise<number> {
  const options = parseOptions(args, { home: true, json: true })
  if (options.help) {
    write("Usage: sandbox data status [--home PATH] [--json]")
    return 0
  }
  const status = await statusReader(options.home ?? env.SANDBOX_HOME)
  if (options.json) write(JSON.stringify(status, null, 2))
  else for (const line of statusSummary(status)) write(line)
  return 0
}

async function pathReadable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.R_OK)
    return true
  } catch {
    return false
  }
}

async function pathWritable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.R_OK | fsConstants.W_OK)
    return true
  } catch {
    return false
  }
}

function printDoctorChecks(checks: DoctorCheck[], write: (message: string) => void): void {
  for (const check of checks) write(`${check.status.toUpperCase().padEnd(4)}  ${check.name}: ${check.detail}`)
}

async function doctorCommand(
  args: string[],
  dependencies: Required<Pick<CliDependencies, "probe" | "dataStatus">> & {
    env: NodeJS.ProcessEnv
    cwd: string
    nodeVersion: string
    pluginSpecifier: string
    metadata: PackageMetadata
    write: (message: string) => void
  },
): Promise<number> {
  const options = parseOptions(args, { home: true, json: true })
  if (options.help) {
    dependencies.write("Usage: sandbox doctor [--home PATH] [--json]")
    return 0
  }

  const checks: DoctorCheck[] = []
  const nodeReady = versionSatisfiesRange(dependencies.nodeVersion, dependencies.metadata.nodeEngine)
  checks.push({
    name: "Node.js",
    status: nodeReady ? "pass" : "fail",
    detail: `${dependencies.nodeVersion} (required ${dependencies.metadata.nodeEngine})`,
  })

  const opencode = await dependencies.probe({
    command: "opencode",
    args: ["--version"],
    cwd: dependencies.cwd,
    env: dependencies.env,
  })
  const detectedVersion = opencode.stdout.trim().split(/\s+/u)[0] ?? ""
  const opencodeReady = opencode.code === 0 && versionAtLeast(detectedVersion, dependencies.metadata.opencodeVersion)
  checks.push({
    name: "OpenCode",
    status: opencodeReady ? "pass" : "fail",
    detail: opencode.code === 0
      ? `${detectedVersion || "unknown version"} (required >=${dependencies.metadata.opencodeVersion})`
      : opencode.stderr.trim() || "command not found",
  })

  const home = sandboxHome(options.home ?? dependencies.env.SANDBOX_HOME)
  const homeReady = await pathWritable(home)
  checks.push({
    name: "SANDBOX home",
    status: homeReady ? "pass" : "fail",
    detail: `${home}${homeReady ? "" : " (run `sandbox setup`)"}`,
  })

  let pluginPath: string | null = null
  try {
    const pluginUrl = new URL(dependencies.pluginSpecifier)
    if (pluginUrl.protocol === "file:") pluginPath = fileURLToPath(pluginUrl)
  } catch {
    pluginPath = null
  }
  const pluginReady = pluginPath ? await pathReadable(pluginPath) : true
  checks.push({
    name: "SANDBOX plugin",
    status: pluginReady ? "pass" : "fail",
    detail: pluginPath ?? dependencies.pluginSpecifier,
  })

  try {
    const status = await dependencies.dataStatus(options.home ?? dependencies.env.SANDBOX_HOME)
    const textbooksReady = status.searchDatabase !== null && status.textbookFiles > 0
    checks.push({
      name: "PhysicsOcean textbooks",
      status: textbooksReady ? "pass" : "warn",
      detail: textbooksReady
        ? `${status.textbookFiles} source file(s), ${formatBytes(status.searchDatabase!.sizeBytes)} index`
        : "not installed",
    })
    checks.push({
      name: "PhysicsOcean arXiv mirror",
      status: status.arxivDatabase ? "pass" : "warn",
      detail: status.arxivDatabase ? formatBytes(status.arxivDatabase.sizeBytes) : "not installed",
    })
  } catch (error) {
    checks.push({ name: "PhysicsOcean", status: "fail", detail: errorMessage(error) })
  }

  if (options.json) dependencies.write(JSON.stringify({ home, checks }, null, 2))
  else printDoctorChecks(checks, dependencies.write)
  return checks.some((check) => check.status === "fail") ? 1 : 0
}

async function dataCommand(
  args: string[],
  env: NodeJS.ProcessEnv,
  write: (message: string) => void,
  install: typeof installPhysicsOceanPacks,
  statusReader: typeof getPhysicsOceanStatus,
): Promise<number> {
  const [subcommand, ...rest] = args
  if (!subcommand || subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    write(DATA_HELP)
    return subcommand ? 0 : 2
  }
  if (subcommand === "install") return dataInstallCommand(rest, env, write, install)
  if (subcommand === "status") return dataStatusCommand(rest, env, write, statusReader)
  throw new UsageError(`Unknown data command: ${subcommand}`)
}

export async function runCli(args: string[], dependencies: CliDependencies = {}): Promise<number> {
  const write = dependencies.stdout ?? console.log
  const writeError = dependencies.stderr ?? console.error
  const env = { ...(dependencies.env ?? process.env) }
  const cwd = dependencies.cwd ?? process.cwd()

  try {
    const metadata = dependencies.packageMetadata ?? await readPackageMetadata()
    const [command, ...rest] = args
    if (command === "help" || command === "--help" || command === "-h") {
      write(HELP)
      return 0
    }
    if (command === "version" || command === "--version" || command === "-v") {
      write(`${metadata.name} ${metadata.version}`)
      return 0
    }
    if (command === "setup") return setupCommand(rest, env, write)
    if (command === "data") {
      return dataCommand(
        rest,
        env,
        write,
        dependencies.installPacks ?? installPhysicsOceanPacks,
        dependencies.dataStatus ?? getPhysicsOceanStatus,
      )
    }
    if (command === "install-physicsocean") {
      return dataInstallCommand(
        rest,
        env,
        write,
        dependencies.installPacks ?? installPhysicsOceanPacks,
      )
    }
    if (command === "doctor") {
      return doctorCommand(rest, {
        probe: dependencies.probe ?? probeProcess,
        dataStatus: dependencies.dataStatus ?? getPhysicsOceanStatus,
        env,
        cwd,
        nodeVersion: dependencies.nodeVersion ?? process.versions.node,
        pluginSpecifier: dependencies.pluginSpecifier ?? DEFAULT_PLUGIN_SPECIFIER,
        metadata,
        write,
      })
    }

    const launchArgs = resolveOpenCodeArguments(args)
    const launchEnv = buildLaunchEnvironment(
      env,
      cwd,
      metadata,
      dependencies.pluginSpecifier ?? DEFAULT_PLUGIN_SPECIFIER,
    )
    return await (dependencies.launch ?? launchProcess)({
      command: "opencode",
      args: launchArgs,
      cwd,
      env: launchEnv,
    })
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      writeError("sandbox: OpenCode is not installed or is not available on PATH")
      return 127
    }
    writeError(`sandbox: ${errorMessage(error)}`)
    return error instanceof UsageError ? 2 : 1
  }
}
