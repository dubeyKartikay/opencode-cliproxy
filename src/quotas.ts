import { LocalClient, record, safeText, type Account } from "./local-client.js"

export type QuotaBucket = { label: string; remainingPercent: number; resetAt?: string; detail?: string }
export type QuotaAccount = {
  label: string; provider: string; status: "fresh" | "stale" | "unavailable" | "disabled"
  checkedAt?: string; plan?: string; buckets: QuotaBucket[]; balances: string[]
  success: number; failed: number; error?: string
}
export type UsageReport = { fetchedAt: string; accounts: QuotaAccount[]; text: string }
const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x)
function iso(x: unknown): string | undefined {
  const date = typeof x === "number" ? new Date(x * 1000) : typeof x === "string" ? new Date(x) : undefined
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}
const windowName = (s: string) => ({ rolling: "5-hour", weekly: "Weekly", monthly: "Monthly" })[s] ?? s

export function normalizeQuota(account: Account, raw: unknown, now = new Date().toISOString()): QuotaAccount {
  if (!record(raw)) throw new Error("Quota response is invalid")
  const result: QuotaAccount = { label: account.label, provider: account.provider, status: "fresh", checkedAt: now,
    buckets: [], balances: [], success: account.success, failed: account.failed }
  if (record(raw.codex)) {
    const data = raw.codex
    result.plan = safeText(data.plan_type)
    const meters: Array<[string, any]> = [["", data.rate_limit], ["Code review · ", data.code_review_rate_limit]]
    if (Array.isArray(data.additional_rate_limits)) for (const meter of data.additional_rate_limits)
      if (record(meter)) meters.push([`${safeText(meter.limit_name, safeText(meter.metered_feature, "Additional"))} · `, meter.rate_limit])
    for (const [prefix, rate] of meters) if (record(rate)) for (const key of ["primary_window", "secondary_window"]) {
      const w = rate[key]; if (!record(w) || !finite(w.used_percent)) continue
      const seconds = w.limit_window_seconds
      const label = seconds === 18000 ? "5-hour" : seconds === 604800 ? "Weekly" : seconds === 86400 ? "Daily" : key === "primary_window" ? "Primary" : "Secondary"
      result.buckets.push({ label: prefix + label, remainingPercent: Math.max(0, Math.min(100, 100 - w.used_percent)), ...(iso(w.reset_at) ? { resetAt: iso(w.reset_at) } : {}) })
    }
    if (record(data.credits) && data.credits.unlimited === true) result.balances.push("Credits: unlimited")
    else if (record(data.credits) && (typeof data.credits.balance === "string" || finite(data.credits.balance)))
      result.balances.push(`Credits: ${safeText(String(data.credits.balance))}`)
  } else {
    if (record(raw.subscription)) result.plan = safeText(raw.subscription.tierName, safeText(raw.subscription.plan))
    if (Array.isArray(raw.groups)) for (const group of raw.groups) {
      if (!record(group) || !Array.isArray(group.buckets)) continue
      for (const b of group.buckets) if (record(b) && finite(b.remainingFraction)) result.buckets.push({
        label: windowName(safeText(b.window)), remainingPercent: Math.max(0, Math.min(100, b.remainingFraction * 100)),
        ...(iso(b.resetTime) ? { resetAt: iso(b.resetTime) } : {}), ...(safeText(b.description) ? { detail: safeText(b.description) } : {}),
      })
    }
    if (Array.isArray(raw.summary)) for (const metric of raw.summary) if (record(metric) && finite(metric.value)) {
      const amount = metric.format === "currency" ? `${safeText(metric.currency, "USD")} ${metric.value.toFixed(2)}` : String(metric.value)
      result.balances.push(`${safeText(metric.label, safeText(metric.key))}: ${amount}`)
    }
  }
  if (!result.buckets.length && !result.balances.length) throw new Error("No quota readings were returned")
  return result
}

export class QuotaService {
  private report?: UsageReport
  private inFlight?: Promise<UsageReport>
  private previous = new Map<string, QuotaAccount>()
  private lastAttempt = 0
  constructor(readonly client: LocalClient, readonly clock = () => Date.now()) {}
  async get(force = false, signal?: AbortSignal): Promise<UsageReport> {
    const age = this.clock() - this.lastAttempt
    if (this.report && age < (force ? 10_000 : 60_000)) return this.report
    if (this.inFlight) return this.inFlight
    this.inFlight = this.load(signal).finally(() => { this.inFlight = undefined })
    return this.inFlight
  }
  private async load(signal?: AbortSignal): Promise<UsageReport> {
    const now = new Date(this.clock()).toISOString()
    const accounts = await this.client.accounts()
    const quota = await Promise.all(accounts.map(async account => {
      const base = { label: account.label, provider: account.provider, buckets: [], balances: [], success: account.success, failed: account.failed }
      if (account.disabled) return { ...base, status: "disabled" as const }
      try {
        const reading = normalizeQuota(account, await this.client.accountQuota(account, signal), now)
        this.previous.set(account.authIndex, reading)
        return reading
      } catch {
        const previous = this.previous.get(account.authIndex)
        return previous ? { ...previous, success: account.success, failed: account.failed, status: "stale" as const, error: "Refresh failed; showing the last successful reading." }
          : { ...base, status: "unavailable" as const, error: "Quota is unavailable. Try refreshing shortly." }
      }
    }))
    this.lastAttempt = this.clock()
    this.report = { fetchedAt: now, accounts: quota, text: formatUsage(quota, now) }
    return this.report
  }
}

export function formatUsage(accounts: QuotaAccount[], fetchedAt: string): string {
  const lines = ["Usage and quotas", `Checked ${new Date(fetchedAt).toLocaleString()}`, ""]
  for (const account of accounts) {
    const provider = ({ "opencode-go": "OpenCode Go", "commandcode-goat": "CommandCode Goat", codex: "Codex" })[account.provider] ?? account.provider
    lines.push(`${account.label}${account.label === provider ? "" : ` · ${provider}`}${account.plan ? ` · ${account.plan}` : ""}`)
    if (account.status !== "fresh") lines.push(`  ${account.status.toUpperCase()}${account.checkedAt ? ` · last good reading ${new Date(account.checkedAt).toLocaleString()}` : ""}`)
    for (const b of account.buckets) {
      const filled = Math.round(b.remainingPercent / 10)
      lines.push(`  ${b.label.padEnd(8)} ${"█".repeat(filled)}${"░".repeat(10 - filled)} ${b.remainingPercent.toFixed(1)}% left${b.resetAt ? ` · resets ${new Date(b.resetAt).toLocaleString()}` : ""}`)
      if (b.detail) lines.push(`    ${b.detail}`)
    }
    for (const balance of account.balances) lines.push(`  ${balance}`)
    lines.push(`  Requests: ${account.success} succeeded · ${account.failed} failed`)
    if (account.error) lines.push(`  ${account.error}`)
    lines.push("")
  }
  lines.push("Quotas are per account; requests are since CLIProxy started.", "Model-specific allowances can differ. Readings refresh at most once per minute.")
  return lines.join("\n")
}
