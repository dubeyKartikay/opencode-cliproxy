import { afterEach, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import server from "./server.js"
const originalFetch = globalThis.fetch
let cleanup: (() => void | Promise<void>) | undefined
afterEach(async () => { await cleanup?.(); cleanup = undefined; globalThis.fetch = originalFetch })
const inventory = { catalog: [], aliases: [{ name: "opencode-go/deepseek-v4.1-flash", alias: "shared/deepseek-v4.1-flash" }], definitions: [{ id: "opencode-go/deepseek-v4.1-flash", display_name: "DeepSeek V4.1 Flash", context_length: 1_000_000, max_completion_tokens: 32768 }], routing: {}, fetchedAt: "2026-11-15T00:00:00Z" }
function harness(connected = true) {
  const state: any = { active: connected, url: "https://server.test.ts.net:8443", key: "test-client-secret", hooks: {}, cache: new Map(), methods: [], removed: [] }
  const transforms: any[] = []
  const ctx = {
    options: {},
    integration: { transform: async (fn: any) => fn({ update: (_id: string, edit: any) => { const ref: any = {}; edit(ref); state.integration = ref }, method: { update: (v: any) => state.methods.push(v) } }),
      connection: { active: async () => state.active ? { type: "credential", id: "credential-one", label: "Server", method: "key" } : undefined,
        resolve: async () => ({ type: "key", key: state.key, metadata: { baseURL: state.url } }), status: async (value: any) => { state.status = value.status } } },
    provider: { transform: async (fn: any) => { transforms.push(fn); fn({ add: (v: any) => { state.registry = v } }) }, reload: async () => { for (const fn of transforms) fn({ add: (v: any) => { state.registry = v } }) } },
    model: { transform: async (fn: any) => { state.modelTransform = fn } },
    storage: { get: async (k: string) => state.cache.get(k), set: async (k: string, v: any) => { state.cache.set(k, v) }, remove: async (k: string) => state.cache.delete(k) },
    session: { hook: async (name: string, fn: any) => { state.hooks[name] = fn }, get: async ({ sessionID }: any) => ({ id: sessionID, ...(sessionID === "child" ? { parentID: "parent" } : {}) }), synthetic: async (input: any) => { state.synthetic = input } },
    rpc: { register: async (_: unknown, handlers: any) => { state.rpc = handlers } }, tool: { transform: async (fn: any) => fn({ add: () => {} }) },
    command: { transform: async (fn: any) => fn({ add: (v: any) => { state.command = v } }) },
    event: { subscribe: async function* ({ signal }: any) { await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true })) } },
  } as unknown as Plugin.Context
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (state.reject) return new Response("test-client-secret", { status: 401 })
    expect((init?.headers as any).Authorization).toBe(`Bearer ${state.key}`)
    if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "shared/deepseek-v4.1-flash", owned_by: "opencode-go" }, { id: "opencode-go/deepseek-v4.1-flash", owned_by: "opencode-go" }] })
    if (String(input).endsWith("/inventory")) return Response.json(inventory)
    if (String(input).includes("/usage")) return Response.json({ text: "75.0% left", accounts: [], fetchedAt: inventory.fetchedAt })
    throw new Error("Unexpected endpoint")
  }) as typeof fetch
  return { state, ctx }
}
test("native connect asks for a URL and key, stores no secrets in model caches, and binds requests to the selected server", async () => {
  const { ctx, state } = harness()
  cleanup = (await server.setup(ctx)) || undefined; await state.rpc.refresh({}, {})
  expect(state.integration.name).toBe("CLIProxy")
  expect(state.methods[0]).toMatchObject({ integrationID: "cliproxy", method: { type: "key", form: [{ key: "baseURL", required: true }] } })
  expect(state.registry.models).toHaveLength(1)
  expect(state.registry.models[0].modelID).toBe("shared/deepseek-v4.1-flash")
  expect(state.registry.sourceConnection.id).toBe("credential-one")
  expect(JSON.stringify([...state.cache.values()])).not.toContain("test-client-secret")
  const request = { sessionID: "child", headers: {} as Record<string, string>, baseURL: "" }
  await state.hooks["model.request"](request)
  expect(request.baseURL).toBe("https://server.test.ts.net:8443/v1")
  expect(request.headers).toMatchObject({ Authorization: "Bearer test-client-secret", "X-Session-Id": "parent", "X-Thread-Id": "parent" })
  await state.command.execute({ sessionID: "parent" }); expect(state.synthetic).toMatchObject({ resume: false, text: "75.0% left" })
})
test("an unconnected device registers the auth flow without assuming localhost credentials", async () => {
  const { ctx, state } = harness(false)
  globalThis.fetch = (async () => { throw new Error("A disconnected plugin must not make network calls") }) as typeof fetch
  cleanup = (await server.setup(ctx)) || undefined; await state.rpc.refresh({}, {})
  expect(state.registry.info.activation).toBe("disabled")
  expect(state.registry.models).toHaveLength(0)
  expect((await state.rpc.status()).message).toContain("/connect")
})
test("rejecting a key removes stale models and marks the connection for attention", async () => {
  const { ctx, state } = harness()
  cleanup = (await server.setup(ctx)) || undefined; await state.rpc.refresh({}, {})
  state.reject = true; await state.rpc.refresh({}, {})
  expect(state.registry.models).toHaveLength(0); expect(state.status.status).toBe("needs_auth")
  expect(state.status.message).not.toContain("test-client-secret")
})
test("switching servers cannot reuse another server's credentials, cached catalog, or request target", async () => {
  const { ctx, state } = harness()
  cleanup = (await server.setup(ctx)) || undefined; await state.rpc.refresh({}, {})
  state.url = "https://other.test.ts.net:8443"; state.key = "second-client-secret"
  await expect(state.hooks["model.request"]({ sessionID: "child", headers: {} })).rejects.toThrow("connection changed")
  await state.rpc.refresh({}, {})
  expect(state.registry.info.settings.baseURL).toBe("https://other.test.ts.net:8443/v1")
  state.active = false; await state.rpc.refresh({}, {})
  expect(state.registry.info.activation).toBe("disabled"); expect(state.registry.models).toHaveLength(0)
})
