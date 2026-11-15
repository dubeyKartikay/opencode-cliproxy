// src/gateway.ts
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

// src/local-client.ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// src/catalog.ts
function normalizeBaseURL(value) {
  const url = new URL(value);
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = pathname.endsWith("/v1") ? pathname : `${pathname}/v1`;
  return url.toString().replace(/\/$/, "");
}
function parseCatalog(input) {
  if (!isRecord(input))
    throw new Error("CLIProxyAPI returned a non-object model catalog");
  const response = input;
  if (!Array.isArray(response.data))
    throw new Error("CLIProxyAPI model catalog is missing the data array");
  const models = response.data.map((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || item.id.trim() === "")
      return;
    const live = parseLiveMetadata(item);
    return {
      id: item.id,
      ...typeof item.owned_by === "string" ? { ownedBy: item.owned_by } : {},
      ...live ? { live } : {}
    };
  }).filter((item) => item !== undefined);
  if (models.length === 0)
    throw new Error("CLIProxyAPI returned no usable models");
  const unique = new Map;
  for (const model of models) {
    if (!unique.has(model.id))
      unique.set(model.id, model);
  }
  return [...unique.values()];
}
function parseLiveMetadata(item) {
  const name = typeof item.display_name === "string" && item.display_name.trim() !== "" ? item.display_name.trim() : undefined;
  const context = tokenLimit(item.context_length);
  const output = tokenLimit(item.max_completion_tokens);
  const limit = {
    ...context !== undefined ? { context } : {},
    ...output !== undefined ? { output } : {}
  };
  if (name === undefined && Object.keys(limit).length === 0)
    return;
  return {
    ...name !== undefined ? { name } : {},
    ...Object.keys(limit).length > 0 ? { limit } : {}
  };
}
function tokenLimit(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/local-client.ts
function record(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function safeText(v, fallback = "") {
  return typeof v === "string" ? v.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 200) : fallback;
}

class LocalClient {
  options;
  fetcher;
  baseURL;
  origin;
  constructor(options = {}, fetcher = fetch) {
    this.options = options;
    this.fetcher = fetcher;
    this.baseURL = normalizeBaseURL(options.baseURL ?? "http://127.0.0.1:8317/v1");
    const url = new URL(this.baseURL);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password)
      throw new Error("The local integration requires a loopback CLIProxy URL");
    this.origin = url.origin;
  }
  async credentials() {
    let file = {};
    const path = this.options.credentialsFile ?? join(process.env.ProgramData ?? "C:\\ProgramData", "CLIProxyAPI", "client-credentials.json");
    try {
      const parsed = JSON.parse(await readFile(path, "utf8"));
      if (record(parsed))
        file = parsed;
    } catch {}
    const apiKey = this.options.apiKey ?? process.env.CLIPROXY_API_KEY ?? file.apiKey;
    const managementKey = this.options.managementKey ?? process.env.CLIPROXY_MANAGEMENT_KEY ?? file.managementKey;
    if (typeof apiKey !== "string" || !apiKey)
      throw new Error("CLIProxy client credential is unavailable");
    return { apiKey, managementKey: typeof managementKey === "string" ? managementKey : undefined };
  }
  async request(path, management = true, body, signal) {
    const keys = await this.credentials();
    const key = management ? keys.managementKey : keys.apiKey;
    if (!key)
      throw new Error("CLIProxy management credential is unavailable");
    const response = await this.fetcher(`${this.origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: { Authorization: `Bearer ${key}`, ...body === undefined ? {} : { "Content-Type": "application/json" } },
      ...body === undefined ? {} : { body: JSON.stringify(body) },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000)
    }).catch(() => {
      throw new Error("CLIProxy request failed or timed out");
    });
    if (!response.ok)
      throw new Error(`CLIProxy returned HTTP ${response.status}`);
    return response.json().catch(() => {
      throw new Error("CLIProxy returned invalid JSON");
    });
  }
  async inventory() {
    const catalog = parseCatalog(await this.request(`${new URL(this.baseURL).pathname}/models`, false));
    const result = { catalog, definitions: [], aliases: [], routing: {}, fetchedAt: new Date().toISOString() };
    try {
      const cfg = await this.request("/v8/management/config");
      const aliases = cfg?.oauth?.["model-alias"];
      if (record(aliases)) {
        for (const list of Object.values(aliases))
          if (Array.isArray(list)) {
            for (const a of list)
              if (record(a) && typeof a.name === "string" && typeof a.alias === "string")
                result.aliases.push({ name: a.name, alias: a.alias });
          }
      }
      result.routing = { strategy: safeText(cfg?.routing?.strategy), affinity: cfg?.routing?.["session-affinity"] === true };
      const channels = [...new Set(catalog.map((m) => m.ownedBy === "openai" ? "codex" : m.ownedBy).filter((v) => !!v))];
      await Promise.all(channels.map(async (channel) => {
        try {
          const data = await this.request(`/v8/management/routing/model-definitions/${encodeURIComponent(channel)}`);
          if (Array.isArray(data?.models)) {
            for (const m of data.models)
              if (record(m) && typeof m.id === "string") {
                result.definitions.push({
                  id: m.id,
                  display_name: safeText(m.display_name),
                  context_length: m.context_length,
                  max_completion_tokens: m.max_completion_tokens,
                  supportedInputModalities: m.supportedInputModalities,
                  supportedOutputModalities: m.supportedOutputModalities,
                  supported_parameters: m.supported_parameters,
                  type: m.type,
                  thinking: m.thinking
                });
              }
          }
        } catch {
          result.warning = "Some model metadata is unavailable; conservative defaults are in use.";
        }
      }));
    } catch {
      result.warning = "Management metadata is unavailable; model discovery is still active.";
    }
    return result;
  }
  async accounts() {
    const data = await this.request("/v0/management/auth-files");
    if (!Array.isArray(data?.files))
      throw new Error("CLIProxy account inventory is unavailable");
    return data.files.filter((f) => record(f) && typeof f.auth_index === "string").map((f) => ({
      name: safeText(f.name),
      provider: safeText(f.provider),
      label: safeText(f.label, safeText(f.provider)),
      authIndex: f.auth_index,
      disabled: f.disabled === true,
      unavailable: f.unavailable === true,
      status: safeText(f.status),
      success: typeof f.success === "number" ? f.success : 0,
      failed: typeof f.failed === "number" ? f.failed : 0
    }));
  }
  async accountQuota(account, signal) {
    if (account.provider !== "codex")
      return this.request("/v0/management/quota/fetch", true, { auth_index: account.authIndex }, signal);
    const result = await this.request("/v8/management/requests/api-call", true, {
      auth_index: account.authIndex,
      method: "GET",
      url: "https://chatgpt.com/backend-api/wham/usage",
      header: { Authorization: "Bearer $TOKEN$", "Content-Type": "application/json", "User-Agent": "codex_cli_rs/0.1.0" }
    }, signal);
    if (result?.status_code !== 200)
      throw new Error(`Codex quota returned HTTP ${Number(result?.status_code) || "unknown"}`);
    try {
      return { codex: typeof result.body === "string" ? JSON.parse(result.body) : result.body };
    } catch {
      throw new Error("Codex quota response is invalid");
    }
  }
}

// src/quotas.ts
var finite = (x) => typeof x === "number" && Number.isFinite(x);
function iso(x) {
  const date = typeof x === "number" ? new Date(x * 1000) : typeof x === "string" ? new Date(x) : undefined;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
var windowName = (s) => ({ rolling: "5-hour", weekly: "Weekly", monthly: "Monthly" })[s] ?? s;
function normalizeQuota(account, raw, now = new Date().toISOString()) {
  if (!record(raw))
    throw new Error("Quota response is invalid");
  const result = {
    label: account.label,
    provider: account.provider,
    status: "fresh",
    checkedAt: now,
    buckets: [],
    balances: [],
    success: account.success,
    failed: account.failed
  };
  if (record(raw.codex)) {
    const data = raw.codex;
    result.plan = safeText(data.plan_type);
    const meters = [["", data.rate_limit], ["Code review · ", data.code_review_rate_limit]];
    if (Array.isArray(data.additional_rate_limits)) {
      for (const meter of data.additional_rate_limits)
        if (record(meter))
          meters.push([`${safeText(meter.limit_name, safeText(meter.metered_feature, "Additional"))} · `, meter.rate_limit]);
    }
    for (const [prefix, rate] of meters)
      if (record(rate))
        for (const key of ["primary_window", "secondary_window"]) {
          const w = rate[key];
          if (!record(w) || !finite(w.used_percent))
            continue;
          const seconds = w.limit_window_seconds;
          const label = seconds === 18000 ? "5-hour" : seconds === 604800 ? "Weekly" : seconds === 86400 ? "Daily" : key === "primary_window" ? "Primary" : "Secondary";
          result.buckets.push({ label: prefix + label, remainingPercent: Math.max(0, Math.min(100, 100 - w.used_percent)), ...iso(w.reset_at) ? { resetAt: iso(w.reset_at) } : {} });
        }
    if (record(data.credits) && data.credits.unlimited === true)
      result.balances.push("Credits: unlimited");
    else if (record(data.credits) && (typeof data.credits.balance === "string" || finite(data.credits.balance)))
      result.balances.push(`Credits: ${safeText(String(data.credits.balance))}`);
  } else {
    if (record(raw.subscription))
      result.plan = safeText(raw.subscription.tierName, safeText(raw.subscription.plan));
    if (Array.isArray(raw.groups))
      for (const group of raw.groups) {
        if (!record(group) || !Array.isArray(group.buckets))
          continue;
        for (const b of group.buckets)
          if (record(b) && finite(b.remainingFraction))
            result.buckets.push({
              label: windowName(safeText(b.window)),
              remainingPercent: Math.max(0, Math.min(100, b.remainingFraction * 100)),
              ...iso(b.resetTime) ? { resetAt: iso(b.resetTime) } : {},
              ...safeText(b.description) ? { detail: safeText(b.description) } : {}
            });
      }
    if (Array.isArray(raw.summary)) {
      for (const metric of raw.summary)
        if (record(metric) && finite(metric.value)) {
          const amount = metric.format === "currency" ? `${safeText(metric.currency, "USD")} ${metric.value.toFixed(2)}` : String(metric.value);
          result.balances.push(`${safeText(metric.label, safeText(metric.key))}: ${amount}`);
        }
    }
  }
  if (!result.buckets.length && !result.balances.length)
    throw new Error("No quota readings were returned");
  return result;
}

class QuotaService {
  client;
  clock;
  report;
  inFlight;
  previous = new Map;
  lastAttempt = 0;
  constructor(client, clock = () => Date.now()) {
    this.client = client;
    this.clock = clock;
  }
  async get(force = false, signal) {
    const age = this.clock() - this.lastAttempt;
    if (this.report && age < (force ? 1e4 : 60000))
      return this.report;
    if (this.inFlight)
      return this.inFlight;
    this.inFlight = this.load(signal).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }
  async load(signal) {
    const now = new Date(this.clock()).toISOString();
    const accounts = await this.client.accounts();
    const quota = await Promise.all(accounts.map(async (account) => {
      const base = { label: account.label, provider: account.provider, buckets: [], balances: [], success: account.success, failed: account.failed };
      if (account.disabled)
        return { ...base, status: "disabled" };
      try {
        const reading = normalizeQuota(account, await this.client.accountQuota(account, signal), now);
        this.previous.set(account.authIndex, reading);
        return reading;
      } catch {
        const previous = this.previous.get(account.authIndex);
        return previous ? { ...previous, success: account.success, failed: account.failed, status: "stale", error: "Refresh failed; showing the last successful reading." } : { ...base, status: "unavailable", error: "Quota is unavailable. Try refreshing shortly." };
      }
    }));
    this.lastAttempt = this.clock();
    this.report = { fetchedAt: now, accounts: quota, text: formatUsage(quota, now) };
    return this.report;
  }
}
function formatUsage(accounts, fetchedAt) {
  const lines = ["Usage and quotas", `Checked ${new Date(fetchedAt).toLocaleString()}`, ""];
  for (const account of accounts) {
    const provider = { "opencode-go": "OpenCode Go", "commandcode-goat": "CommandCode Goat", codex: "Codex" }[account.provider] ?? account.provider;
    lines.push(`${account.label}${account.label === provider ? "" : ` · ${provider}`}${account.plan ? ` · ${account.plan}` : ""}`);
    if (account.status !== "fresh")
      lines.push(`  ${account.status.toUpperCase()}${account.checkedAt ? ` · last good reading ${new Date(account.checkedAt).toLocaleString()}` : ""}`);
    for (const b of account.buckets) {
      const filled = Math.round(b.remainingPercent / 10);
      lines.push(`  ${b.label.padEnd(8)} ${"█".repeat(filled)}${"░".repeat(10 - filled)} ${b.remainingPercent.toFixed(1)}% left${b.resetAt ? ` · resets ${new Date(b.resetAt).toLocaleString()}` : ""}`);
      if (b.detail)
        lines.push(`    ${b.detail}`);
    }
    for (const balance of account.balances)
      lines.push(`  ${balance}`);
    lines.push(`  Requests: ${account.success} succeeded · ${account.failed} failed`);
    if (account.error)
      lines.push(`  ${account.error}`);
    lines.push("");
  }
  lines.push("Quotas are per account; requests are since CLIProxy started.", "Model-specific allowances can differ. Readings refresh at most once per minute.");
  return lines.join(`
`);
}

// src/gateway.ts
function createGateway(options = {}) {
  const client = options.client ?? new LocalClient({ baseURL: process.env.CLIPROXY_BASE_URL, credentialsFile: process.env.CLIPROXY_CREDENTIALS_FILE });
  const quotas = new QuotaService(client);
  let cached;
  let pending;
  async function inventory() {
    if (cached && Date.now() - Date.parse(cached.fetchedAt) < 60000)
      return cached;
    if (pending)
      return pending;
    pending = client.inventory().then((data) => {
      cached = data;
      return data;
    }).finally(() => {
      pending = undefined;
    });
    return pending;
  }
  const validate = options.validate ?? (async (key) => {
    const response = await fetch(`${client.baseURL}/models`, { headers: { Authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(1e4) });
    if (!response.ok)
      throw new Error("Unauthorized");
    const value = await response.json();
    if (!Array.isArray(value?.data))
      throw new Error("Unavailable");
    return value.data.filter((m) => record(m) && typeof m.id === "string").map((m) => m.id);
  });
  const json = (res, status, value) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(JSON.stringify(value));
  };
  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method !== "GET") {
      json(res, 405, { error: "Read-only endpoint" });
      return;
    }
    if (url.pathname === "/opencode/health") {
      json(res, 200, { service: "cliproxy-opencode", version: "2.0.1" });
      return;
    }
    if (!["/opencode/v1/inventory", "/opencode/v1/usage"].includes(url.pathname)) {
      json(res, 404, { error: "Not found" });
      return;
    }
    const authorization = req.headers.authorization;
    if (!authorization?.startsWith("Bearer ") || authorization.length > 8192) {
      json(res, 401, { error: "CLIProxy API key required" });
      return;
    }
    let allowed;
    try {
      allowed = await validate(authorization.slice(7));
    } catch {
      json(res, 401, { error: "Invalid CLIProxy API key or backend unavailable" });
      return;
    }
    if (url.pathname.endsWith("/inventory")) {
      const data = await inventory();
      const allowedIDs = new Set(allowed);
      const aliases = data.aliases.filter((a) => allowedIDs.has(a.alias) || allowedIDs.has(a.name));
      const definitions = new Set([...allowed, ...aliases.map((a) => a.name)]);
      json(res, 200, { ...data, catalog: data.catalog.filter((m) => allowedIDs.has(m.id)), aliases, definitions: data.definitions.filter((m) => definitions.has(m.id)) });
      return;
    }
    json(res, 200, await quotas.get(url.searchParams.get("refresh") === "1"));
  }
  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent)
        json(res, 503, { error: "CLIProxy companion is temporarily unavailable" });
      else
        res.end();
    });
  });
  server.requestTimeout = 35000;
  server.headersTimeout = 1e4;
  return server;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = createGateway();
  server.listen(Number(process.env.CLIPROXY_COMPANION_PORT ?? 8318), "127.0.0.1");
  server.on("error", () => {
    process.exitCode = 1;
  });
  const stop = () => {
    server.close();
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
export {
  createGateway
};
