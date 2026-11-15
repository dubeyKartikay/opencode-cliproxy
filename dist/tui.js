// @bun
// src/rpc.ts
import { Rpc } from "@opencode/plugin/rpc";
var LocalRpc = Rpc.define({
  id: "opencode-cliproxy",
  methods: {
    usage: {
      input: { type: "object", properties: { force: { type: "boolean" } }, additionalProperties: false },
      output: { type: "object", properties: { text: { type: "string" }, accounts: { type: "array", items: { type: "object" } }, fetchedAt: { type: "string" } }, required: ["text", "accounts", "fetchedAt"] }
    },
    refresh: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: { type: "object", properties: { models: { type: "number" }, message: { type: "string" } }, required: ["models", "message"] }
    },
    status: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: { type: "object", properties: { models: { type: "number" }, fetchedAt: { type: "string" }, message: { type: "string" } }, required: ["models", "fetchedAt", "message"] }
    }
  },
  events: {}
});
var rpc_default = LocalRpc;

// src/tui.ts
var tui_default = {
  id: "opencode-cliproxy",
  setup(ctx) {
    const rpc = ctx.client.rpc(LocalRpc);
    const location = () => ctx.location ?? ctx.data.location.default();
    const showUsage = async (force = false) => {
      ctx.ui.toast.show({ title: "Usage and quotas", message: "Reading account quotas\u2026", variant: "info" });
      try {
        const report = await rpc.usage({ force }, { location: location() });
        const selected = await ctx.ui.dialog.select({
          title: "Usage and quotas",
          placeholder: "Choose an account, or refresh",
          options: [
            ...report.accounts.map((a, index) => ({
              title: a.label,
              value: String(index),
              description: a.status === "fresh" ? a.buckets.map((b) => `${b.label}: ${b.remainingPercent.toFixed(1)}%`).join(" \xB7 ") || a.balances.join(" \xB7 ") : a.status.toUpperCase(),
              category: { "opencode-go": "OpenCode Go", "commandcode-goat": "CommandCode Goat", codex: "Codex" }[a.provider] ?? a.provider
            })),
            { title: "Refresh quotas", value: "refresh", description: "Fetch the latest readings" }
          ]
        });
        if (selected === undefined)
          return;
        if (selected === "refresh")
          return showUsage(true);
        const account = report.accounts[Number(selected)];
        const message = account ? formatAccount(account, report.fetchedAt) : report.text;
        await ctx.ui.dialog.alert({ title: "Usage and quotas", message });
      } catch {
        ctx.ui.toast.show({ title: "Usage and quotas", message: "Could not read quotas. Check /connect \u2192 CLIProxy and your Tailscale connection.", variant: "error" });
      }
    };
    ctx.keymap.layer(() => ({ mode: "global", commands: [
      { id: "local-models.usage", title: "View usage and quotas", group: "Models", palette: true, slash: { name: "quota", aliases: ["quotas", "usage"] }, run: () => showUsage() },
      { id: "local-models.refresh", title: "Refresh available models", group: "Models", palette: true, slash: { name: "models-refresh" }, run: async () => {
        try {
          const r = await rpc.refresh({}, { location: location() });
          ctx.ui.toast.show({ title: "Models", message: r.message, variant: "success" });
        } catch {
          ctx.ui.toast.show({ title: "Models", message: "Could not refresh models. The previous list is still available.", variant: "error" });
        }
      } }
    ] }));
  }
};
function formatAccount(account, fetchedAt) {
  const lines = [
    account.label + (account.plan ? ` \xB7 ${account.plan}` : ""),
    `${account.status === "fresh" ? "Checked" : account.status.toUpperCase() + " \xB7 last checked"}: ${new Date(account.checkedAt ?? fetchedAt).toLocaleString()}`,
    "",
    "Remaining quota \xB7 reset time (local)"
  ];
  const resetFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  for (const b of account.buckets) {
    const filled = Math.round(b.remainingPercent / 20);
    lines.push(`${b.label.padEnd(8)} ${"\u2588".repeat(filled)}${"\u2591".repeat(5 - filled)} ${b.remainingPercent.toFixed(1)}%${b.resetAt ? ` \xB7 ${resetFormat.format(new Date(b.resetAt))}` : ""}`);
  }
  const balances = account.balances.filter((balance) => !/:\s*[A-Z]{3}\s+0\.00$/.test(balance));
  if (balances.length)
    lines.push("", ...balances);
  lines.push("", `Requests since restart: ${account.success} OK \xB7 ${account.failed} failed`);
  if (account.error)
    lines.push(account.error);
  if (account.provider === "commandcode-goat")
    lines.push("Model-specific allowances can differ.");
  return lines.join(`
`);
}
export {
  tui_default as default,
  formatAccount
};
