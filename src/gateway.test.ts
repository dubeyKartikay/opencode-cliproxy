import { afterEach, expect, test } from "bun:test"
import type { Server } from "node:http"
import { createGateway } from "./gateway.js"
import type { LocalClient } from "./local-client.js"
let server: Server | undefined
afterEach(async () => { if (server) await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined })
async function start() {
  const client = { baseURL: "http://127.0.0.1:8317/v1", inventory: async () => ({ catalog: [{ id: "shared/allowed" }, { id: "private" }], aliases: [{ name: "provider/allowed", alias: "shared/allowed" }], definitions: [{ id: "provider/allowed" }, { id: "private" }], routing: {}, fetchedAt: new Date().toISOString() }),
    accounts: async () => [{ label: "Main", provider: "opencode-go", authIndex: "never-expose-auth-index", success: 1, failed: 0 }],
    accountQuota: async () => ({ groups: [{ buckets: [{ window: "rolling", remainingFraction: 0.75 }] }] }),
  } as unknown as LocalClient
  server = createGateway({ assetsDir: ".", client, validate: async key => { if (key !== "client-key") throw new Error("management-secret"); return ["shared/allowed"] } })
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve))
  return `http://127.0.0.1:${(server.address() as any).port}`
}
test("the companion denies anonymous and invalid-key quota requests", async () => {
  const url = await start()
  expect((await fetch(url + "/opencode/v1/usage")).status).toBe(401)
  const response = await fetch(url + "/opencode/v1/usage", { headers: { Authorization: "Bearer wrong" } })
  expect(response.status).toBe(401); expect(await response.text()).not.toContain("management-secret")
})
test("the companion is read-only and exposes no management proxy or arbitrary file access", async () => {
  const url = await start()
  for (const path of ["/v8/management/config", "/opencode/plugin/files/client-credentials.json", "/opencode/plugin/files/../../secret"]) expect((await fetch(url + path)).status).toBe(404)
  expect((await fetch(url + "/opencode/v1/usage", { method: "POST" })).status).toBe(405)
})
test("model metadata respects the inference key's catalog and quota replies contain no auth identifiers", async () => {
  const url = await start(); const headers = { Authorization: "Bearer client-key" }
  const data = await (await fetch(url + "/opencode/v1/inventory", { headers })).json() as any
  expect(data.catalog.map((m: any) => m.id)).toEqual(["shared/allowed"])
  expect(data.definitions.map((m: any) => m.id)).toEqual(["provider/allowed"])
  const quota = await (await fetch(url + "/opencode/v1/usage", { headers })).text()
  expect(quota).toContain("75.0% left"); expect(quota).not.toContain("never-expose-auth-index")
})
