import { expect, test } from "bun:test"
import { normalizeServerURL, RemoteClient } from "./remote-client.js"
test("server URLs normalize consistently across devices", () => {
  expect(normalizeServerURL("host.tailnet.ts.net:8443/")).toBe("https://host.tailnet.ts.net:8443/v1")
  expect(normalizeServerURL("https://host.tailnet.ts.net:8443/v1/")).toBe("https://host.tailnet.ts.net:8443/v1")
  expect(normalizeServerURL("http://100.64.0.1:8317")).toBe("http://100.64.0.1:8317/v1")
  expect(normalizeServerURL("https://proxy.example.com/prefix")).toBe("https://proxy.example.com/prefix/v1")
})
test("URLs cannot hide credentials, query tokens, dashboards, or insecure public HTTP", () => {
  for (const url of ["https://user:key@host.ts.net", "https://host.ts.net?key=secret", "https://host.ts.net/management.html", "http://public.example.com", "ftp://host.ts.net"])
    expect(() => normalizeServerURL(url)).toThrow()
})
test("remote requests send only the inference key, never follow redirects, and redact server errors", async () => {
  const client = new RemoteClient("https://host.ts.net", "secret", (async (_url, init) => { expect(init?.redirect).toBe("error"); expect(init?.headers).toEqual({ Authorization: "Bearer secret" }); return new Response("secret", { status: 401 }) }) as typeof fetch)
  await expect(client.inventory()).rejects.toThrow("rejected the API key")
})
test("a plain CLIProxy server remains usable when the read-only metadata companion is down", async () => {
  const client = new RemoteClient("https://host.ts.net", "secret", (async url => String(url).endsWith("/models") ? Response.json({ data: [{ id: "shared/deepseek-v4.1-flash" }] }) : new Response("offline", { status: 503 })) as typeof fetch)
  const inventory = await client.inventory(); expect(inventory.catalog).toHaveLength(1); expect(inventory.warning).toContain("metadata")
})
