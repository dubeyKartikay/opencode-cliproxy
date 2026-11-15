import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import tui, { formatAccount } from "./tui.js"
import type { QuotaAccount } from "./quotas.js"
const account: QuotaAccount = { label: "Main", provider: "opencode-go", status: "fresh", checkedAt: "2026-11-15T00:00:00Z", success: 4, failed: 0, buckets: [{ label: "5-hour", remainingPercent: 75, resetAt: "2026-11-15T05:00:00Z" }], balances: [] }
test("quota is a local dialog command with one searchable account entry", async () => {
  let commands: any[] = []; let selection: any; let alert: any
  tui.setup({
    client: { rpc: () => ({ usage: async () => ({ accounts: [account], fetchedAt: account.checkedAt, text: "Full report" }) }) },
    location: { directory: "C:/project" }, data: { location: { default: () => ({ directory: "C:/project" }) } },
    keymap: { layer: (factory: any) => { commands = factory().commands } },
    ui: { toast: { show: () => {} }, dialog: { select: async (value: any) => { selection = value; return "0" }, alert: async (value: any) => { alert = value } } },
  } as unknown as Plugin.Context)
  await commands.find(c => c.slash.name === "quota").run()
  expect(selection.options.filter((o: any) => o.title === "Main")).toHaveLength(1)
  expect(alert.message).toContain("75.0%")
  expect(alert.message).not.toContain("Full report")
})
test("individual quota details fit a terminal without duplicating the report heading", () => {
  const text = formatAccount(account, account.checkedAt!)
  expect(text.split("\n").length).toBeLessThan(15)
  expect(text).toContain("reset time (local)")
  expect(text).not.toContain("Usage and quotas\nUsage and quotas")
})
test("the largest current account card fits a short terminal", () => {
  const goat = { ...account, provider: "commandcode-goat", buckets: [account.buckets[0]!, { label: "Weekly", remainingPercent: 90 }, { label: "Monthly", remainingPercent: 23.8 }], balances: ["Monthly credits remaining: USD 16.65", "Purchased credits: USD 0.00", "Free credits: USD 0.00"] }
  expect(formatAccount(goat, account.checkedAt!).split("\n").length).toBeLessThanOrEqual(12)
})
