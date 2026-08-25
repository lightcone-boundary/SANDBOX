import type { Config } from "@opencode-ai/plugin"
import { describe, expect, test } from "bun:test"

import { createPhysicsHooks } from "../src/index.js"

const nativeTools = [
  "arxiv_fetch",
  "arxiv_search",
  "paper_citations",
  "paper_references",
  "physics_catalog",
  "physics_read",
  "physics_search",
]

describe("SANDBOX plugin", () => {
  test("loads the canonical agent and registers the native tools", async () => {
    const hooks = createPhysicsHooks(true)
    const config: Config = {
      agent: {
        existing: {
          description: "Existing project agent",
          prompt: "Keep this agent.",
        },
      },
    }

    await hooks.config?.(config)

    expect(Object.keys(hooks.tool ?? {}).sort()).toEqual(nativeTools)
    expect(config.agent?.existing?.prompt).toBe("Keep this agent.")
    expect(config.agent?.build?.disable).toBe(true)
    expect(config.agent?.plan?.disable).toBe(true)

    const agent = config.agent?.["sandbox-physics"]
    expect(agent?.description).toContain("grounded physics research")
    expect(agent?.mode).toBe("primary")
    expect(agent?.temperature).toBe(0)
    expect(agent?.steps).toBe(30)
    expect(agent).not.toHaveProperty("maxSteps")
    expect(agent?.prompt).toContain("## Native research tools")
  })

  test("returns no hooks when SANDBOX is disabled", () => {
    expect(createPhysicsHooks(false)).toEqual({})
  })
})
