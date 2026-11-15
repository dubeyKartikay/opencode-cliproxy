import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { fileURLToPath } from "node:url"
import { LocalClient, record, type Inventory } from "./local-client.js"
import { QuotaService } from "./quotas.js"

export type GatewayOptions = { assetsDir?: string; client?: LocalClient; validate?: (key: string) => Promise<string[]> }
export function createGateway(options: GatewayOptions = {}) {
  const client = options.client ?? new LocalClient({ baseURL: process.env.CLIPROXY_BASE_URL, credentialsFile: process.env.CLIPROXY_CREDENTIALS_FILE })
  const quotas = new QuotaService(client)
  let cached: Inventory | undefined
  let pending: Promise<Inventory> | undefined
  async function inventory() {
    if (cached && Date.now() - Date.parse(cached.fetchedAt) < 60_000) return cached
    if (pending) return pending
    pending = client.inventory().then(data => { cached = data; return data }).finally(() => { pending = undefined })
    return pending
  }
  const validate = options.validate ?? (async (key: string) => {
    const response = await fetch(`${client.baseURL}/models`, { headers: { Authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error("Unauthorized")
    const value = await response.json() as any
    if (!Array.isArray(value?.data)) throw new Error("Unavailable")
    return value.data.filter((m: unknown) => record(m) && typeof m.id === "string").map((m: any) => m.id)
  })
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" })
    res.end(JSON.stringify(value))
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost")
    if (req.method !== "GET") { json(res, 405, { error: "Read-only endpoint" }); return }
    if (url.pathname === "/opencode/health") { json(res, 200, { service: "cliproxy-opencode", version: "2.0.1" }); return }
    if (!["/opencode/v1/inventory", "/opencode/v1/usage"].includes(url.pathname)) { json(res, 404, { error: "Not found" }); return }
    const authorization = req.headers.authorization
    if (!authorization?.startsWith("Bearer ") || authorization.length > 8192) { json(res, 401, { error: "CLIProxy API key required" }); return }
    let allowed: string[]
    try { allowed = await validate(authorization.slice(7)) } catch { json(res, 401, { error: "Invalid CLIProxy API key or backend unavailable" }); return }
    if (url.pathname.endsWith("/inventory")) {
      const data = await inventory()
      const allowedIDs = new Set(allowed)
      const aliases = data.aliases.filter(a => allowedIDs.has(a.alias) || allowedIDs.has(a.name))
      const definitions = new Set([...allowed, ...aliases.map(a => a.name)])
      json(res, 200, { ...data, catalog: data.catalog.filter(m => allowedIDs.has(m.id)), aliases, definitions: data.definitions.filter(m => definitions.has(m.id)) })
      return
    }
    json(res, 200, await quotas.get(url.searchParams.get("refresh") === "1"))
  }
  const server = createServer((req, res) => { void handle(req, res).catch(() => {
    if (!res.headersSent) json(res, 503, { error: "CLIProxy companion is temporarily unavailable" }); else res.end()
  }) })
  server.requestTimeout = 35_000; server.headersTimeout = 10_000
  return server
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = createGateway()
  server.listen(Number(process.env.CLIPROXY_COMPANION_PORT ?? 8318), "127.0.0.1")
  server.on("error", () => { process.exitCode = 1 })
  const stop = () => { server.close(); setTimeout(() => process.exit(0), 3000).unref() }
  process.on("SIGTERM", stop); process.on("SIGINT", stop)
}
