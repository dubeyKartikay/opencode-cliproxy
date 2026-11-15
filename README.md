# OpenCode CLIProxy

An MIT-licensed OpenCode v2 plugin for CLIProxyAPI. Connect with a server URL and client API key, then select models by name.

## Install from GitHub

Requires OpenCode **2.2.7 or newer**. Runtime bundles are included; no npm publication or local build is required.

```sh
opencode plugin add github:dubeyKartikay/opencode-cliproxy
```

Start OpenCode, run **/connect**, and choose **CLIProxy**. Enter your base URL (for example, `https://your-node.your-tailnet.ts.net:8443`) and your **CLIProxy client API key**. An optional `/v1` suffix is accepted. OpenCode stores the connection in its native credential store. Clients never need the server management key.

## Use

- **/models**: one inventory with readable names; configured backend aliases and provider copies are combined.
- **/quota**: account quota windows, reset times and balances when the server companion is installed.
- **/models-refresh**: refresh discovery now; otherwise refreshes every five minutes.
- **/quota-report**: add a complete report to a session without running a model.
- **model_usage**: a read-only tool for the assistant to answer usage questions.

Backend routing, retries, cooldowns and account rotation stay in CLIProxyAPI. Stable root-session headers preserve affinity for follow-ups and child sessions. Deployment metadata supplies token limits, modalities and thinking controls. Shared routes use common capabilities and the smallest advertised limits. Distinct speed, paid/free and dated models remain separate.

The plugin uses Anthropic Messages for Claude, Responses for native Codex and compatible Chat Completions for other routes. It defaults to DeepSeek V4.1 Flash when available. To retain other providers in the picker, configure this plugin with `exclusiveModels: false`.

## Quota and metadata companion

Normal inference works with a standard CLIProxy endpoint. Enhanced model metadata and quotas use an optional companion on the **server**, not on client computers. An existing compatible companion can be reused.

The companion binds to `127.0.0.1:8318` and provides:

- `GET /opencode/v1/inventory`
- `GET /opencode/v1/usage`
- `GET /opencode/health`

The first two endpoints validate the supplied client API key against CLIProxy. They expose only sanitized model metadata and quota readings. They provide no management proxy, arbitrary upstream URL, file browser, or mutation endpoint. Quotas are cached briefly and failed readings are marked stale or unavailable, never unlimited. Subscription meters can differ from model-specific allowances.

On the server, build the companion and run `node host/gateway.js`. It reads local credentials from the standard Windows CLIProxy credential file, a `CLIPROXY_CREDENTIALS_FILE` JSON file containing `apiKey` and `managementKey`, or the `CLIPROXY_API_KEY` and `CLIPROXY_MANAGEMENT_KEY` environment variables. These credentials belong only on the server. `CLIPROXY_BASE_URL` optionally selects a different loopback backend; the default is `http://127.0.0.1:8317/v1`.

For Tailscale Serve, route `/v1` to CLIProxy's `/v1` and `/opencode` to this companion's `/opencode` under the same HTTPS origin. Publish only those paths. The server owner controls service startup; if the companion is offline, inference continues with cached or default metadata and quota viewing is temporarily unavailable.

## Update and remove

```sh
opencode plugin update github:dubeyKartikay/opencode-cliproxy
opencode plugin remove github:dubeyKartikay/opencode-cliproxy
```

If upgrading from the earlier directory-based installer, remove that local plugin directory after installing this GitHub package so only one copy loads. Native saved connections are retained.

## Development

Node.js 20+ and Bun 1.4.4 are used for development. Run `npm ci` and `npm run check`; `BUN_BINARY` can select an installed Bun executable. CI tests Windows, Linux and macOS. Runtime bundles in `dist` are committed for direct Git installation. No npm publishing workflow is included.

Derived from [moutansos/opencode2-cliproxyapi](https://github.com/moutansos/opencode2-cliproxyapi); see LICENSE and NOTICE. No credentials, personal endpoints, account reports or machine-specific verification artifacts belong in this repository.
