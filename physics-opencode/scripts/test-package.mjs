import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repositoryRoot = resolve(packageRoot, "..")
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm"

function runNpm(args, captureOutput = false) {
  const result = spawnSync(npmCommand, args, {
    cwd: packageRoot,
    encoding: "utf8",
    stdio: captureOutput ? ["ignore", "pipe", "inherit"] : "inherit",
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${npmCommand} ${args.join(" ")} exited with status ${result.status}`)
  }
  return result.stdout ?? ""
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const makefile = await readFile(resolve(repositoryRoot, "Makefile"), "utf8")
const publishRecipe = /^publish:[^\n]*\n\t([^\n]+)$/m.exec(makefile)?.[1]
assert(
  publishRecipe === "npm publish ./physics-opencode --access public",
  `the Makefile publish target does not pass the nested package to npm publish: ${publishRecipe}`,
)

runNpm(["run", "build"])

const packageManifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"))
const packageLock = JSON.parse(await readFile(resolve(packageRoot, "package-lock.json"), "utf8"))
const citation = await readFile(resolve(repositoryRoot, "CITATION.cff"), "utf8")
const citationVersion = /^version:\s*"([^"]+)"$/m.exec(citation)?.[1]
assert(packageLock.version === packageManifest.version, "package-lock.json version differs from package.json")
assert(
  packageLock.packages?.[""]?.version === packageManifest.version,
  "package-lock.json root package version differs from package.json",
)
assert(citationVersion === packageManifest.version, "CITATION.cff version differs from package.json")
assert(
  packageManifest.bin?.sandbox === "dist/cli.js",
  "the sandbox bin target is not in npm's canonical package-relative form",
)

const sourceAgent = await readFile(
  resolve(repositoryRoot, ".opencode", "agents", "sandbox-physics.md"),
  "utf8",
)
const bundledAgent = await readFile(
  resolve(packageRoot, "dist", "assets", "agents", "sandbox-physics.md"),
  "utf8",
)
assert(sourceAgent === bundledAgent, "the bundled agent differs from the outer canonical agent")

const plugin = (await import(new URL("../dist/index.js", import.meta.url))).default
const hooks = await plugin.server()
const config = {}
await hooks.config?.(config)

const expectedTools = [
  "arxiv_fetch",
  "arxiv_search",
  "paper_citations",
  "paper_references",
  "physics_catalog",
  "physics_read",
  "physics_search",
]
const registeredTools = Object.keys(hooks.tool ?? {}).sort()
assert(
  JSON.stringify(registeredTools) === JSON.stringify(expectedTools),
  `unexpected native tools: ${registeredTools.join(", ")}`,
)

const agent = config.agent?.["sandbox-physics"]
assert(agent?.mode === "primary", "sandbox-physics is not a primary agent")
assert(agent?.steps === 30, "sandbox-physics does not have the expected 30-step limit")
assert(!Object.hasOwn(agent, "maxSteps"), "sandbox-physics still emits deprecated maxSteps")
assert(agent?.prompt?.includes("## Native research tools"), "sandbox-physics prompt was not loaded")

const packResult = JSON.parse(runNpm(["pack", "--dry-run", "--json", "--ignore-scripts"], true))
const packedFiles = packResult[0]?.files?.map((file) => file.path) ?? []
assert(
  packedFiles.includes("dist/assets/agents/sandbox-physics.md"),
  "npm package does not include the bundled agent",
)
assert(
  !packedFiles.some((path) => path.startsWith(".opencode/") || path.startsWith("assets/")),
  "npm package includes a second OpenCode config or source asset directory",
)

console.log(
  `Package smoke passed: ${registeredTools.length} tools, sandbox-physics agent, exact bundled prompt, ${packedFiles.length} tarball files.`,
)
