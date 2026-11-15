import { expect, test } from "bun:test"
import { normalizeQuota, QuotaService, formatUsage } from "./quotas.js"
import { LocalClient, safeText, type Account } from "./local-client.js"
const account: Account = { name: "Main.json", label: "Main", provider: "opencode-go", authIndex: "internal", status: "active", disabled: false, unavailable: false, success: 10, failed: 1 }
const raw = { groups: [{ buckets: [{ window: "rolling", remainingFraction: 0.75, resetTime: "2026-11-15T12:00:00Z" }, { window: "weekly", remainingFraction: 0.5 }] }] }
test("plugin quota fractions are remaining, not consumed", () => {
  expect(normalizeQuota(account, raw).buckets.map(b => b.remainingPercent)).toEqual([75, 50])
})
test("Codex usage percentages become remaining quota, with epoch reset times", () => {
  const q = normalizeQuota(account, { codex: { plan_type: "plus", rate_limit: { primary_window: { used_percent: 78, limit_window_seconds: 18000, reset_at: 1794711424 } } } })
  expect(q.buckets[0]).toMatchObject({ label: "5-hour", remainingPercent: 22, resetAt: "2026-11-15T02:57:04.000Z" })
})
test("unknown or malformed quota is never represented as unlimited", () => {
  expect(() => normalizeQuota(account, {})).toThrow("No quota readings")
  expect(() => normalizeQuota(account, { groups: [{ buckets: [{ remainingFraction: "1" }] }] })).toThrow()
})
test("Goat balances preserve their currency and monthly allowance caveat", () => {
  const q = normalizeQuota(account, { summary: [{ key: "monthly", label: "Monthly credits remaining", value: 16.65, currency: "USD", format: "currency" }], groups: [{ buckets: [{ window: "monthly", remainingFraction: 0.2, description: "Model-specific boosts may differ" }] }] })
  expect(q.balances[0]).toBe("Monthly credits remaining: USD 16.65")
  expect(formatUsage([q], new Date().toISOString())).toContain("Model-specific boosts may differ")
})
test("cached quota requests coalesce; failed refresh preserves a dated stale reading", async () => {
  let now = 100_000; let calls = 0; let fails = false
  const client = { accounts: async () => [account], accountQuota: async () => { calls++; if (fails) throw new Error("secret server body"); return raw } } as unknown as LocalClient
  const service = new QuotaService(client, () => now)
  const [first, second] = await Promise.all([service.get(), service.get()])
  expect(first).toEqual(JSON.parse(JSON.stringify(first)))
  expect(calls).toBe(1); expect(first).toBe(second)
  await service.get(true); expect(calls).toBe(1)
  fails = true; now += 61_000
  const stale = await service.get()
  expect(stale.accounts[0]).toMatchObject({ status: "stale", checkedAt: first.fetchedAt })
  expect(stale.text).toContain("STALE")
  expect(stale.text).not.toContain("secret server body")
})
test("disabled accounts are listed without probing upstream", async () => {
  let calls = 0
  const client = { accounts: async () => [{ ...account, disabled: true }], accountQuota: async () => { calls++; return raw } } as unknown as LocalClient
  const report = await new QuotaService(client).get()
  expect(calls).toBe(0); expect(report.accounts[0]!.status).toBe("disabled")
})
test("management credentials are restricted to loopback hosts", () => {
  expect(() => new LocalClient({ baseURL: "https://example.com/v1" })).toThrow("loopback")
  expect(() => new LocalClient({ baseURL: "http://user:pass@localhost:8317/v1" })).toThrow("loopback")
})
test("quota errors never expose management response bodies or tokens", async () => {
  const client = new LocalClient({ apiKey: "client-secret", managementKey: "admin-secret" }, (async (_url, init) => {
    expect(init?.redirect).toBe("error")
    return new Response("admin-secret", { status: 401 })
  }) as typeof fetch)
  await expect(client.request("/v0/management/auth-files")).rejects.toThrow("CLIProxy returned HTTP 401")
})
test("server labels cannot inject terminal escape sequences", () => { expect(safeText("Main\x1b[31m\nAccount")).not.toContain("\x1b") })
