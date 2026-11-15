import { Model, Provider } from "@opencode/plugin"
import { buildModel } from "./index.js"
import type { CatalogModel, ModelMetadataCatalog } from "./catalog.js"
import type { Definition, Inventory } from "./local-client.js"

export const tail = (id: string) => id.slice(id.lastIndexOf("/") + 1)
const positive = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0
const intersect = (lists: string[][]) => lists.length ? [...new Set(lists[0])].filter(x => lists.every(l => l.includes(x))) : []
export type Route = { id: string; name: string; target: string; members: string[]; model: Model.Info }
function rank(m: CatalogModel) { return m.id.startsWith("shared/") ? 0 : !m.id.includes("/") ? 1 : m.id.startsWith("opencode-go/") ? 2 : 3 }

export function buildUnified(inventory: Inventory, metadata: ModelMetadataCatalog = {}): Route[] {
  const groups = new Map<string, CatalogModel[]>()
  const names = new Map(inventory.aliases.map(a => [a.name, tail(a.alias)]))
  const definitions = new Map(inventory.definitions.map(m => [m.id, m]))
  for (const model of inventory.catalog) {
    const id = names.get(model.id) ?? tail(model.id)
    const group = groups.get(id) ?? []; group.push(model); groups.set(id, group)
  }
  const routes: Route[] = []
  const providerID = Provider.ID.make("models")
  for (const [id, group] of groups) {
    const selected = [...group].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))[0]!
    const members = selected.id.startsWith("shared/")
      ? inventory.aliases.filter(a => a.alias === selected.id).map(a => a.name)
      : [selected.id]
    const defs = members.map(m => definitions.get(m)).filter((d): d is Definition => !!d)
    if (!defs.length && definitions.has(selected.id)) defs.push(definitions.get(selected.id)!)
    const preferred = defs.find(d => d.id.startsWith("opencode-go/")) ?? defs[0]
    const fallback = buildModel({ providerID, model: { ...selected, id }, metadata })
    const inputs = defs.filter(d => d.supportedInputModalities?.length).map(d => d.supportedInputModalities!)
    // The Goat gateway supports text/images even when the base model catalog advertises more modalities.
    if (members.some(m => m.startsWith("commandcode-goat/"))) inputs.push(["text", "image"])
    const input = intersect(inputs)
    const output = intersect(defs.filter(d => d.supportedOutputModalities?.length).map(d => d.supportedOutputModalities!))
    const isClaude = /^claude-/.test(id)
    const isCodex = selected.ownedBy === "openai" && /^(gpt-[5-9]|gpt-\d{2}|codex)/.test(id) && !/image/.test(id)
    const image = /image|dall-e/.test(id) || output.includes("image")
    const name = cleanName(preferred?.display_name || fallback.name || id)
    const contexts = defs.map(d => d.context_length).filter(positive)
    const outputs = defs.map(d => d.max_completion_tokens).filter(positive)
    const context = contexts.length ? Math.min(...contexts) : fallback.limit.context
    const maxOutput = Math.min(outputs.length ? Math.min(...outputs) : fallback.limit.output, context)
    const levels = defs.length && defs.length === members.length && defs.every(d => d.thinking?.levels?.length)
      ? intersect(defs.map(d => d.thinking!.levels!)) : []
    if (isClaude && defs.length && defs.every(d => d.thinking?.zero_allowed || d.thinking?.levels?.includes("none")) && !levels.includes("none")) levels.unshift("none")
    const variants: Array<Model.Info["variants"][number]> = levels.map(effort => ({ id: Model.VariantID.make(effort), settings:
      isClaude ? (effort === "none" ? { thinking: { type: "disabled" } } : { thinking: { type: "adaptive" }, effort })
      : { reasoningEffort: effort } }))
    if (isClaude && !levels.some(e => e !== "none") && defs.length && defs.every(d => positive(d.thinking?.min))) {
      const minimum = Math.max(...defs.map(d => d.thinking!.min!))
      const ceiling = Math.min(maxOutput - 1, ...defs.map(d => positive(d.thinking?.max) ? d.thinking!.max! : 32768))
      if (ceiling >= minimum) for (const [effort, budgetTokens] of [["low", minimum], ["medium", Math.min(ceiling, Math.max(minimum, 8192))], ["high", ceiling]] as const)
        variants.push({ id: Model.VariantID.make(effort), settings: { thinking: { type: "enabled", budgetTokens } } })
    }
    const model: Model.Info = {
      ...fallback, id: Model.ID.make(id), modelID: Model.ID.make(selected.id), name,
      package: isClaude ? "@opencode/ai/providers/anthropic" : isCodex ? "@opencode/ai/providers/openai/responses" : "@opencode/ai/providers/openai-compatible",
      compatibility: isClaude || isCodex ? {} : { reasoningField: "reasoning_content", maxTokensField: "max_tokens" },
      capabilities: { tools: !image && fallback.capabilities.tools, input: input.length ? input : fallback.capabilities.input, output: output.length ? output : fallback.capabilities.output },
      variants: variants.length ? variants : fallback.variants,
      limit: { context, output: maxOutput },
      // Subscription credits are not the public per-token list price. Let OpenCode show token counts, not fictional bills.
      cost: [],
      ...(image ? { type: "image" } : {}),
    }
    routes.push({ id, name, target: selected.id, members, model })
  }
  return routes.sort((a, b) => a.name.localeCompare(b.name))
}
export function cleanName(name: string) {
  return name.replace(/\s*\((?:shared|opencode go|commandcode goat|openai)\)\s*/gi, " ").replace(/\s+1017\b/g, "").trim()
}
