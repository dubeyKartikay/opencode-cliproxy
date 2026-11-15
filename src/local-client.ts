import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { normalizeBaseURL, parseCatalog, type CatalogModel } from "./catalog.js"

export type Alias = { name: string; alias: string }
export type Definition = {
  id: string; display_name?: string; context_length?: number; max_completion_tokens?: number
  supportedInputModalities?: string[]; supportedOutputModalities?: string[]
  supported_parameters?: string[]; type?: string
  thinking?: { levels?: string[]; zero_allowed?: boolean; min?: number; max?: number }
}
export type Account = {
  name: string; provider: string; label: string; authIndex: string
  disabled: boolean; unavailable: boolean; status: string; success: number; failed: number
}
export type Inventory = {
  catalog: CatalogModel[]; definitions: Definition[]; aliases: Alias[]
  routing: { strategy?: string; affinity?: boolean }; fetchedAt: string; warning?: string
}
export type LocalOptions = { baseURL?: string; credentialsFile?: string; apiKey?: string; managementKey?: string }
export function record(v: unknown): v is Record<string, any> { return typeof v === "object" && v !== null && !Array.isArray(v) }
export function safeText(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 200) : fallback
}

export class LocalClient {
  readonly baseURL: string
  readonly origin: string
  constructor(readonly options: LocalOptions = {}, readonly fetcher: typeof fetch = fetch) {
    this.baseURL = normalizeBaseURL(options.baseURL ?? "http://127.0.0.1:8317/v1")
    const url = new URL(this.baseURL)
    // This integration auto-reads the local management credential. Never send it off-machine.
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password)
      throw new Error("The local integration requires a loopback CLIProxy URL")
    this.origin = url.origin
  }
  async credentials() {
    let file: Record<string, any> = {}
    const path = this.options.credentialsFile ?? join(process.env.ProgramData ?? "C:\\ProgramData", "CLIProxyAPI", "client-credentials.json")
    try { const parsed: unknown = JSON.parse(await readFile(path, "utf8")); if (record(parsed)) file = parsed } catch {}
    const apiKey = this.options.apiKey ?? process.env.CLIPROXY_API_KEY ?? file.apiKey
    const managementKey = this.options.managementKey ?? process.env.CLIPROXY_MANAGEMENT_KEY ?? file.managementKey
    if (typeof apiKey !== "string" || !apiKey) throw new Error("CLIProxy client credential is unavailable")
    return { apiKey, managementKey: typeof managementKey === "string" ? managementKey : undefined }
  }
  async request(path: string, management = true, body?: unknown, signal?: AbortSignal): Promise<any> {
    const keys = await this.credentials()
    const key = management ? keys.managementKey : keys.apiKey
    if (!key) throw new Error("CLIProxy management credential is unavailable")
    const response = await this.fetcher(`${this.origin}${path}`, {
      method: body === undefined ? "GET" : "POST", redirect: "error",
      headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000),
    }).catch(() => { throw new Error("CLIProxy request failed or timed out") })
    if (!response.ok) throw new Error(`CLIProxy returned HTTP ${response.status}`)
    // Never include server response bodies in errors: management payloads can contain credentials.
    return response.json().catch(() => { throw new Error("CLIProxy returned invalid JSON") })
  }
  async inventory(): Promise<Inventory> {
    const catalog = parseCatalog(await this.request(`${new URL(this.baseURL).pathname}/models`, false))
    const result: Inventory = { catalog, definitions: [], aliases: [], routing: {}, fetchedAt: new Date().toISOString() }
    try {
      const cfg = await this.request("/v8/management/config")
      const aliases = cfg?.oauth?.["model-alias"]
      if (record(aliases)) for (const list of Object.values(aliases)) if (Array.isArray(list)) for (const a of list)
        if (record(a) && typeof a.name === "string" && typeof a.alias === "string") result.aliases.push({ name: a.name, alias: a.alias })
      result.routing = { strategy: safeText(cfg?.routing?.strategy), affinity: cfg?.routing?.["session-affinity"] === true }
      const channels = [...new Set(catalog.map(m => m.ownedBy === "openai" ? "codex" : m.ownedBy).filter((v): v is string => !!v))]
      await Promise.all(channels.map(async channel => {
        try {
          const data = await this.request(`/v8/management/routing/model-definitions/${encodeURIComponent(channel)}`)
          if (Array.isArray(data?.models)) for (const m of data.models) if (record(m) && typeof m.id === "string") {
            result.definitions.push({ id: m.id, display_name: safeText(m.display_name), context_length: m.context_length,
              max_completion_tokens: m.max_completion_tokens, supportedInputModalities: m.supportedInputModalities,
              supportedOutputModalities: m.supportedOutputModalities, supported_parameters: m.supported_parameters,
              type: m.type, thinking: m.thinking })
          }
        } catch { result.warning = "Some model metadata is unavailable; conservative defaults are in use." }
      }))
    } catch { result.warning = "Management metadata is unavailable; model discovery is still active." }
    return result
  }
  async accounts(): Promise<Account[]> {
    const data = await this.request("/v0/management/auth-files")
    if (!Array.isArray(data?.files)) throw new Error("CLIProxy account inventory is unavailable")
    return data.files.filter((f: unknown) => record(f) && typeof f.auth_index === "string").map((f: any) => ({
      name: safeText(f.name), provider: safeText(f.provider), label: safeText(f.label, safeText(f.provider)),
      authIndex: f.auth_index, disabled: f.disabled === true, unavailable: f.unavailable === true,
      status: safeText(f.status), success: typeof f.success === "number" ? f.success : 0, failed: typeof f.failed === "number" ? f.failed : 0,
    }))
  }
  async accountQuota(account: Account, signal?: AbortSignal): Promise<unknown> {
    if (account.provider !== "codex") return this.request("/v0/management/quota/fetch", true, { auth_index: account.authIndex }, signal)
    // Read-only native Codex quota probe; the proxy substitutes its own token. It never leaves the proxy.
    const result = await this.request("/v8/management/requests/api-call", true, {
      auth_index: account.authIndex, method: "GET", url: "https://chatgpt.com/backend-api/wham/usage",
      header: { Authorization: "Bearer $TOKEN$", "Content-Type": "application/json", "User-Agent": "codex_cli_rs/0.1.0" },
    }, signal)
    if (result?.status_code !== 200) throw new Error(`Codex quota returned HTTP ${Number(result?.status_code) || "unknown"}`)
    try { return { codex: typeof result.body === "string" ? JSON.parse(result.body) : result.body } }
    catch { throw new Error("Codex quota response is invalid") }
  }
}
