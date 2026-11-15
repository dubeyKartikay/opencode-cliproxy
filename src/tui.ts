import type { Plugin } from "@opencode/plugin/tui"
import { LocalRpc } from "./rpc.js"
import type { UsageReport } from "./quotas.js"

export default {
  id: "opencode-cliproxy",
  setup(ctx: Plugin.Context) {
    const rpc = ctx.client.rpc(LocalRpc)
    const location = () => ctx.location ?? ctx.data.location.default()
    const showUsage = async (force = false) => {
      ctx.ui.toast.show({ title: "Usage and quotas", message: "Reading account quotas…", variant: "info" })
      try {
        const report = await rpc.usage({ force }, { location: location() }) as UsageReport
        // Pick an account for the full detail so the view fits small terminals.
        const selected = await ctx.ui.dialog.select({ title: "Usage and quotas", placeholder: "Choose an account, or refresh",
          options: [
            ...report.accounts.map((a, index) => ({ title: a.label, value: String(index),
              description: a.status === "fresh" ? a.buckets.map(b => `${b.label}: ${b.remainingPercent.toFixed(1)}%`).join(" · ") || a.balances.join(" · ") : a.status.toUpperCase(),
              category: ({ "opencode-go": "OpenCode Go", "commandcode-goat": "CommandCode Goat", codex: "Codex" } as Record<string, string>)[a.provider] ?? a.provider })),
            { title: "Refresh quotas", value: "refresh", description: "Fetch the latest readings" },
          ] })
        if (selected === undefined) return
        if (selected === "refresh") return showUsage(true)
        const account = report.accounts[Number(selected)]
        const message = account ? formatAccount(account, report.fetchedAt) : report.text
        await ctx.ui.dialog.alert({ title: "Usage and quotas", message })
      } catch { ctx.ui.toast.show({ title: "Usage and quotas", message: "Could not read quotas. Check /connect → CLIProxy and your Tailscale connection.", variant: "error" }) }
    }
    ctx.keymap.layer(() => ({ mode: "global", commands: [
      { id: "local-models.usage", title: "View usage and quotas", group: "Models", palette: true, slash: { name: "quota", aliases: ["quotas", "usage"] }, run: () => showUsage() },
      { id: "local-models.refresh", title: "Refresh available models", group: "Models", palette: true, slash: { name: "models-refresh" }, run: async () => {
        try { const r = await rpc.refresh({}, { location: location() }) as { models: number; message: string }; ctx.ui.toast.show({ title: "Models", message: r.message, variant: "success" }) }
        catch { ctx.ui.toast.show({ title: "Models", message: "Could not refresh models. The previous list is still available.", variant: "error" }) }
      } },
    ] }))
  },
} satisfies Plugin.Definition

import type { QuotaAccount } from "./quotas.js"
export function formatAccount(account: QuotaAccount, fetchedAt: string) {
  const lines = [account.label + (account.plan ? ` · ${account.plan}` : ""),
    `${account.status === "fresh" ? "Checked" : account.status.toUpperCase() + " · last checked"}: ${new Date(account.checkedAt ?? fetchedAt).toLocaleString()}`, "", "Remaining quota · reset time (local)"]
  const resetFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })
  for (const b of account.buckets) {
    const filled = Math.round(b.remainingPercent / 20)
    lines.push(`${b.label.padEnd(8)} ${"█".repeat(filled)}${"░".repeat(5 - filled)} ${b.remainingPercent.toFixed(1)}%${b.resetAt ? ` · ${resetFormat.format(new Date(b.resetAt))}` : ""}`)
  }
  const balances = account.balances.filter(balance => !/:\s*[A-Z]{3}\s+0\.00$/.test(balance))
  if (balances.length) lines.push("", ...balances)
  lines.push("", `Requests since restart: ${account.success} OK · ${account.failed} failed`)
  if (account.error) lines.push(account.error)
  if (account.provider === "commandcode-goat") lines.push("Model-specific allowances can differ.")
  return lines.join("\n")
}
