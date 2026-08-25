import { describe, expect, test } from "bun:test"

import { responseBytes, responseText } from "../src/network.js"

async function rejectionMessage(operation: Promise<unknown>): Promise<string> {
  try {
    await operation
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error("Expected operation to reject")
}

describe("bounded response readers", () => {
  test("reads byte and text responses within the configured limit", async () => {
    expect(await responseBytes(new Response(new Uint8Array([1, 2, 3])), 3)).toEqual(
      new Uint8Array([1, 2, 3]),
    )
    expect(await responseText(new Response("native physics"), 14)).toBe("native physics")
  })

  test("rejects declared oversized responses before reading the body", async () => {
    const response = new Response("small", { headers: { "content-length": "100" } })
    expect(await rejectionMessage(responseBytes(response, 10))).toContain(
      "Response is too large (100 bytes; limit 10)",
    )
  })

  test("stops an unbounded stream as soon as the byte limit is crossed", async () => {
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        controller.enqueue(new Uint8Array([1, 2, 3]))
        if (pulls === 10) controller.close()
      },
    })

    expect(await rejectionMessage(responseBytes(new Response(body), 5))).toContain(
      "Response exceeded the 5-byte limit",
    )
    expect(pulls).toBeLessThan(10)
  })

  test("applies text limits to UTF-8 bytes rather than character count", async () => {
    expect(await rejectionMessage(responseText(new Response("éé"), 3))).toContain(
      "Response exceeded the 3-byte limit",
    )
  })
})
