import { Integration, Plugin, Provider } from "@opencode/plugin"
import { createHash } from "node:crypto"
import { record, type Inventory } from "./local-client.js"
import { buildUnified, type Route } from "./unified.js"
import { LocalRpc } from "./rpc.js"
import { INTEGRATION_ID, registerAuth, selectedConnection, type SelectedConnection } from "./auth.js"

export default Plugin.define({
  id: "opencode-cliproxy",
  async setup(ctx) {
    const providerID = Provider.ID.make("models")
    let closed = false
    let selected: SelectedConnection | undefined
    let identity = ""
    let generation = 0
    let routes: Route[] = []
    let cached: Inventory | undefined
    let fetchedAt = ""
    let message = "Use /connect → CLIProxy to enter your server URL and API key."
    let pending: { identity: string; promise: Promise<void> } | undefined
    const controller = new AbortController()
    const roots = new Map<string, string>()
    const source = { ...Provider.Info.empty(providerID), name: "Models", integrationID: Integration.ID.make(INTEGRATION_ID),
      activation: "disabled" as "enabled" | "disabled", package: "@opencode/ai/providers/openai-compatible", settings: {} as Record<string, unknown> }
    const apply = (data: Inventory) => { cached = data; routes = buildUnified(data); fetchedAt = data.fetchedAt }
    await registerAuth(ctx)
    await ctx.provider.transform(editor => {
      editor.add({ info: source, models: routes.map(r => r.model), ...(selected ? { sourceConnection: selected.info } : {}) })
    })
    await ctx.model.transform(editor => {
      if (!routes.length || !selected || source.activation !== "enabled") return
      if (ctx.options.exclusiveModels !== false) for (const model of editor.list()) if (model.providerID !== providerID) editor.remove(model.providerID, model.id)
      const preferred = routes.find(r => r.id === "deepseek-v4.1-flash") ?? routes.find(r => r.model.type !== "image")
      const current = editor.default.get()
      if (preferred && (!current || (ctx.options.exclusiveModels !== false && current.providerID !== providerID) || (current.providerID === providerID && !routes.some(r => r.id === current.modelID)))) editor.default.set(providerID, preferred.id)
    })
    const cacheKey = () => "inventory:" + createHash("sha256").update(identity).digest("hex")
    const refresh = async () => {
      if (closed) return
      let next: SelectedConnection | undefined
      let selectionError = false
      try { next = await selectedConnection(ctx) } catch (error) {
        selectionError = true; message = error instanceof Error ? error.message : "Reconnect CLIProxy using /connect."
        const connection = await ctx.integration.connection.active(INTEGRATION_ID).catch(() => undefined)
        if (connection) await ctx.integration.connection.status({ integrationID: INTEGRATION_ID, connection, status: { status: "needs_auth", message } }).catch(() => {})
      }
      const nextIdentity = next ? `${next.baseURL}\0${next.info.type === "credential" ? next.info.id : next.info.name}\0${createHash("sha256").update(next.apiKey).digest("hex")}` : ""
      if (nextIdentity !== identity) {
        generation++; identity = nextIdentity; selected = next; routes = []; cached = undefined; fetchedAt = ""; roots.clear()
        source.activation = "disabled"; source.settings = next ? { baseURL: next.baseURL, apiKey: next.apiKey } : {}
        if (next) {
          const stored: unknown = await ctx.storage.get(cacheKey()).catch(() => undefined)
          if (record(stored) && Array.isArray(stored.catalog) && Array.isArray(stored.definitions) && Array.isArray(stored.aliases)) {
            try { apply(stored as Inventory); source.activation = "enabled" } catch {}
          }
        }
        await ctx.provider.reload()
      }
      if (!selected) { if (!selectionError) message = "Use /connect → CLIProxy to enter your server URL and API key."; return }
      if (pending?.identity === identity) return pending.promise
      const current = selected; const stamp = generation; const key = cacheKey()
      const operation = (async () => {
        try {
          const data = await current.client.inventory()
          if (closed || stamp !== generation) return
          if (data.warning && cached) {
            if (!data.aliases.length) data.aliases = cached.aliases
            const known = new Set(data.definitions.map(m => m.id))
            data.definitions.push(...cached.definitions.filter(m => !known.has(m.id)))
          }
          apply(data); source.activation = "enabled"; message = data.warning ?? `Connected. ${routes.length} models available.`
          await ctx.integration.connection.status({ integrationID: INTEGRATION_ID, connection: current.info, status: undefined })
          await ctx.storage.set(key, JSON.parse(JSON.stringify(data))).catch(() => {})
          await ctx.provider.reload()
        } catch (error) {
          if (closed || stamp !== generation) return
          message = error instanceof Error ? error.message : "Cannot connect to CLIProxy."
          const authenticationError = message.includes("rejected the API key")
          if (authenticationError) { routes = []; cached = undefined; source.activation = "disabled"; await ctx.storage.remove(key).catch(() => {}) }
          await ctx.integration.connection.status({ integrationID: INTEGRATION_ID, connection: current.info, status: { status: "needs_auth", message } }).catch(() => {})
          await ctx.provider.reload()
        }
      })()
      const entry = { identity, promise: operation }
      pending = entry
      try { await operation } finally { if (pending === entry) pending = undefined }
    }
    const sessionRoot = async (id: string) => {
      const known = roots.get(id); if (known) return known
      let current = id; const visited: string[] = []
      try {
        for (let n = 0; n < 32; n++) {
          visited.push(current)
          const info = await ctx.session.get({ sessionID: current })
          if (!info.parentID || visited.includes(info.parentID)) break
          current = roots.get(info.parentID) ?? info.parentID
          if (roots.has(info.parentID)) break
        }
      } catch { current = id }
      if (roots.size > 2000) roots.clear()
      for (const item of visited) roots.set(item, current)
      return current
    }
    await ctx.session.hook("model.request", async event => {
      const current = await selectedConnection(ctx)
      if (!current || current.baseURL !== selected?.baseURL || current.apiKey !== selected?.apiKey) throw new Error("CLIProxy connection changed. Refresh models before continuing.")
      event.baseURL = current.baseURL
      const authorization = Object.keys(event.headers).find(k => k.toLowerCase() === "authorization") ?? "Authorization"
      event.headers[authorization] = `Bearer ${current.apiKey}`
      const root = await sessionRoot(event.sessionID)
      for (const name of ["X-Session-Id", "X-Thread-Id"]) {
        const key = Object.keys(event.headers).find(k => k.toLowerCase() === name.toLowerCase()) ?? name
        event.headers[key] = root
      }
    }, { providerID })
    const usage = async (force: boolean, signal?: AbortSignal) => {
      const current = await selectedConnection(ctx)
      if (!current) throw new Error("Connect CLIProxy using /connect first.")
      return current.client.usage(force, signal)
    }
    await ctx.rpc.register(LocalRpc, {
      usage: async (input, call) => usage(record(input) && input.force === true, call.signal),
      refresh: async () => { await refresh(); return { models: routes.length, message } },
      status: async () => ({ models: routes.length, fetchedAt, message }),
    })
    await ctx.tool.transform(editor => {
      editor.add({ name: "model_usage", description: "Read subscription quotas, reset times and request counts from the connected CLIProxy server. Read-only.",
        input: { type: "object", properties: {}, additionalProperties: false }, execute: async (_, call) => ({ content: (await usage(false, call.signal)).text }) })
    })
    await ctx.command.transform(editor => {
      editor.add({ name: "quota-report", description: "Add the complete usage and quota report to this session", execute: async input => {
        let text: string
        try { text = (await usage(false)).text } catch { text = "Quotas are unavailable. Check your CLIProxy connection and Tailscale." }
        await ctx.session.synthetic({ sessionID: input.sessionID, text, description: "Usage and quotas", resume: false })
      } })
    })
    void (async () => {
      try { for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if ((event.type === "credential.updated" || event.type === "credential.switched") && event.data.integrationID === INTEGRATION_ID) void refresh().catch(() => {})
      } } catch {}
    })()
    void refresh().catch(() => {})
    const timer = setInterval(() => { void refresh().catch(() => {}) }, 300_000); timer.unref?.()
    return () => { closed = true; controller.abort(); clearInterval(timer) }
  },
})
