import { parseCatalog } from "./catalog.js"
import { record, type Inventory } from "./local-client.js"
import type { UsageReport } from "./quotas.js"

export function normalizeServerURL(input: string): string {
  const value = input.trim()
  let url: URL
  try { url = new URL(value.includes("://") ? value : `https://${value}`) } catch { throw new Error("Enter a valid CLIProxy base URL") }
  if (url.username || url.password || url.search || url.hash) throw new Error("Use a base URL without credentials, query parameters or fragments")
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  const parts = host.split(".").map(Number)
  const tailnet = host.endsWith(".ts.net") || (parts.length === 4 && parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127) || host.startsWith("fd7a:115c:a1e0:")
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(host)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (tailnet || loopback))) throw new Error("Use HTTPS, or an HTTP address inside Tailscale or localhost")
  const path = url.pathname.replace(/\/+$/, "")
  if (/\.(?:html?|json)$/i.test(path)) throw new Error("Enter the server base URL, not a dashboard or file URL")
  url.pathname = path.endsWith("/v1") ? path : `${path}/v1`
  return url.toString().replace(/\/$/, "")
}

export class RemoteClient {
  readonly baseURL: string
  readonly extensionURL: string
  constructor(baseURL: string, private readonly apiKey: string, readonly fetcher: typeof fetch = fetch) {
    this.baseURL = normalizeServerURL(baseURL)
    this.extensionURL = this.baseURL.replace(/\/v1$/, "") + "/opencode/v1"
    if (!apiKey.trim()) throw new Error("Enter the CLIProxy API key")
  }
  async json(url: string, signal?: AbortSignal): Promise<any> {
    const response = await this.fetcher(url, { headers: { Authorization: `Bearer ${this.apiKey}` }, redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    }).catch(() => { throw new Error("Cannot reach CLIProxy. Check the URL and your Tailscale connection.") })
    if (response.status === 401 || response.status === 403) throw new Error("CLIProxy rejected the API key. Reconnect using /connect.")
    if (!response.ok) throw new Error(`CLIProxy returned HTTP ${response.status}`)
    return response.json().catch(() => { throw new Error("CLIProxy returned an invalid response") })
  }
  async inventory(): Promise<Inventory> {
    // Validate the inference key even when the companion's metadata is cached or unavailable.
    const catalog = parseCatalog(await this.json(`${this.baseURL}/models`))
    try {
      const data = await this.json(`${this.extensionURL}/inventory`)
      if (!record(data) || !Array.isArray(data.definitions) || !Array.isArray(data.aliases)) throw new Error("Metadata unavailable")
      return { catalog, definitions: data.definitions, aliases: data.aliases, routing: record(data.routing) ? data.routing : {},
        fetchedAt: new Date().toISOString(), ...(typeof data.warning === "string" ? { warning: data.warning } : {}) }
    } catch {
      return { catalog, definitions: [], aliases: [], routing: {}, fetchedAt: new Date().toISOString(),
        warning: "Connected. Server metadata is temporarily unavailable; using cached or conservative model settings." }
    }
  }
  async usage(force = false, signal?: AbortSignal): Promise<UsageReport> {
    const data = await this.json(`${this.extensionURL}/usage${force ? "?refresh=1" : ""}`, signal)
    if (!record(data) || typeof data.text !== "string" || typeof data.fetchedAt !== "string" || !Array.isArray(data.accounts)) throw new Error("Quota endpoint is unavailable on this server")
    return data as UsageReport
  }
}
