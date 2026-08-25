import { chmod, copyFile, mkdir } from "node:fs/promises"

const bundledAgentDirectory = new URL("../dist/assets/agents/", import.meta.url)
const bundledAgent = new URL("sandbox-physics.md", bundledAgentDirectory)
const sourceAgent = new URL("../../.opencode/agents/sandbox-physics.md", import.meta.url)

await mkdir(bundledAgentDirectory, { recursive: true })
await copyFile(sourceAgent, bundledAgent)

if (process.platform !== "win32") {
  await chmod(new URL("../dist/cli.js", import.meta.url), 0o755)
}
