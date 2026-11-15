import type { Plugin } from "@opencode/plugin"
import type { ConnectionInfo } from "@opencode/client"
import { normalizeServerURL, RemoteClient } from "./remote-client.js"

export const INTEGRATION_ID = "cliproxy"
export const connectionForm = [{ type: "string" as const, key: "baseURL", title: "CLIProxy base URL",
  description: "Paste the Tailscale HTTPS URL of your CLIProxy server. /v1 is optional.",
  placeholder: "https://your-computer.your-tailnet.ts.net:8443", required: true, minLength: 1,
  pattern: "^(https?://)?[^\\s]+$" }] as const
export type SelectedConnection = { info: ConnectionInfo; baseURL: string; apiKey: string; client: RemoteClient }
export async function registerAuth(ctx: Plugin.Context) {
  await ctx.integration.transform(editor => {
    editor.update(INTEGRATION_ID, integration => { integration.name = "CLIProxy" })
    editor.method.update({ integrationID: INTEGRATION_ID, method: { type: "key", label: "CLIProxy API key", form: connectionForm } })
  })
}
export async function selectedConnection(ctx: Plugin.Context): Promise<SelectedConnection | undefined> {
  const info = await ctx.integration.connection.active(INTEGRATION_ID)
  if (!info) return
  const credential = await ctx.integration.connection.resolve(info)
  if (credential?.type !== "key") return
  const entered = credential.metadata?.baseURL
  if (typeof entered !== "string") throw new Error("Reconnect CLIProxy and enter its base URL")
  const baseURL = normalizeServerURL(entered)
  return { info, baseURL, apiKey: credential.key, client: new RemoteClient(baseURL, credential.key) }
}
