import { describe, expect, test } from "bun:test"
import { buildUnified } from "./unified.js"
import type { Inventory } from "./local-client.js"

function inventory(): Inventory {
  return { catalog: [
    { id: "shared/deepseek-v4.1-flash", ownedBy: "commandcode-goat" },
    { id: "opencode-go/deepseek-v4.1-flash", ownedBy: "opencode-go" },
    { id: "commandcode-goat/deepseek/deepseek-v4.1-flash", ownedBy: "commandcode-goat" },
  ], aliases: [
    { name: "opencode-go/deepseek-v4.1-flash", alias: "shared/deepseek-v4.1-flash" },
    { name: "commandcode-goat/deepseek/deepseek-v4.1-flash", alias: "shared/deepseek-v4.1-flash" },
  ], definitions: [
    { id: "opencode-go/deepseek-v4.1-flash", display_name: "DeepSeek V4.1 Flash 1017", context_length: 1_000_000, max_completion_tokens: 384_000,
      supportedInputModalities: ["text", "image"], supportedOutputModalities: ["text"], thinking: { levels: ["none", "low", "high", "max"] } },
    { id: "commandcode-goat/deepseek/deepseek-v4.1-flash", display_name: "DeepSeek Flash", context_length: 1_000_000, max_completion_tokens: 32_768,
      supportedInputModalities: ["text"], supportedOutputModalities: ["text"], thinking: { levels: ["low", "high"] } },
  ], routing: {}, fetchedAt: new Date().toISOString() }
}
describe("unified model picker", () => {
  test("one model with a readable name maps to the shared backend route", () => {
    const routes = buildUnified(inventory())
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", target: "shared/deepseek-v4.1-flash" })
    expect(routes[0]!.model.modelID).toBe("shared/deepseek-v4.1-flash")
    expect(routes[0]!.model.compatibility).toEqual({ reasoningField: "reasoning_content", maxTokensField: "max_tokens" })
  })
  test("pooled deployments use the intersection of limits, modalities and reasoning levels", () => {
    const model = buildUnified(inventory())[0]!.model
    expect(model.limit).toEqual({ context: 1_000_000, output: 32_768 })
    expect(model.capabilities.input).toEqual(["text"])
    expect(model.variants.map(v => v.id)).toEqual(["low", "high"])
    expect(model.cost).toEqual([])
  })
  test("catalog order cannot change the chosen route", () => {
    const data = inventory(); data.catalog.reverse(); data.definitions.reverse()
    expect(buildUnified(data)[0]!.target).toBe("shared/deepseek-v4.1-flash")
  })
  test("provider-specific models stay available with clean IDs", () => {
    const data = inventory(); data.catalog.push({ id: "commandcode-goat/anthropic/claude-sonnet-5-5", ownedBy: "commandcode-goat" })
    const model = buildUnified(data).find(r => r.id === "claude-sonnet-5-5")!.model
    expect(model.modelID).toBe("commandcode-goat/anthropic/claude-sonnet-5-5")
    expect(model.package).toBe("@opencode/ai/providers/anthropic")
  })
  test("Codex uses Responses; Go and Goat GPT routes stay on the translated chat endpoint", () => {
    const data = inventory(); data.catalog = [{ id: "gpt-6-astra", ownedBy: "openai" }, { id: "shared/gpt-6-luna", ownedBy: "opencode-go" }]
    const routes = buildUnified(data)
    expect(routes.find(r => r.id === "gpt-6-astra")!.model.package).toBe("@opencode/ai/providers/openai/responses")
    expect(routes.find(r => r.id === "gpt-6-luna")!.model.package).toBe("@opencode/ai/providers/openai-compatible")
  })
  test("image models never appear as chat models with tool calling", () => {
    const data = inventory(); data.catalog = [{ id: "gpt-image-2.5-flare", ownedBy: "openai" }]
    expect(buildUnified(data)[0]!.model).toMatchObject({ type: "image", capabilities: { tools: false } })
  })
  test("unconfirmed model variants are not collapsed", () => {
    const data = inventory(); data.catalog = [{ id: "opencode-go/hy3" }, { id: "commandcode-goat/tencent/hy3-paid" }]
    expect(buildUnified(data).map(r => r.id).sort()).toEqual(["hy3", "hy3-paid"])
  })
  test("missing management metadata still produces a usable catalog", () => {
    const data = inventory(); data.aliases = []; data.definitions = []
    const model = buildUnified(data)[0]!.model
    expect(model.modelID).toBe("shared/deepseek-v4.1-flash")
    expect(model.limit.context).toBeGreaterThan(0)
  })
  test("older Claude models use budgeted thinking instead of adaptive thinking", () => {
    const data = inventory(); data.catalog = [{ id: "commandcode-goat/claude-haiku-4-5-20251001" }]
    data.definitions = [{ id: "commandcode-goat/claude-haiku-4-5-20251001", thinking: { min: 1024 }, max_completion_tokens: 64000 }]
    const variants = buildUnified(data)[0]!.model.variants
    expect(variants.map(v => v.id)).toEqual(["low", "medium", "high"])
    expect(variants[0]!.settings).toEqual({ thinking: { type: "enabled", budgetTokens: 1024 } })
  })
  test("Claude can disable thinking only when every backend declares that support", () => {
    const data = inventory(); data.catalog = [{ id: "commandcode-goat/claude-haiku-5-5" }]
    data.definitions = [{ id: "commandcode-goat/claude-haiku-5-5", thinking: { zero_allowed: true, levels: ["low", "high"] } }]
    expect(buildUnified(data)[0]!.model.variants[0]).toMatchObject({ id: "none", settings: { thinking: { type: "disabled" } } })
  })
})
