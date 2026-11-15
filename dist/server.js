// @bun
// src/server.ts
import { Integration, Plugin as Plugin2, Provider as Provider3 } from "@opencode/plugin";
import { createHash as createHash2 } from "crypto";

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
async function discoverModels(input) {
  const response = await (input.fetcher ?? fetch)(`${input.baseURL}/models`, {
    headers: input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : undefined,
    signal: AbortSignal.timeout(input.timeoutMs)
  });
  if (!response.ok) {
    const detail = (await response.text()).trim().slice(0, 300);
    throw new Error(`CLIProxyAPI model discovery failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return parseCatalog(await response.json());
}
function parseModelMetadataCatalog(input) {
  if (!isRecord(input))
    throw new Error("Model metadata service returned a non-object catalog");
  return Object.fromEntries(Object.entries(input).flatMap(([providerID, provider]) => {
    if (!isRecord(provider))
      return [];
    const models = Object.fromEntries(Object.entries(isRecord(provider.models) ? provider.models : {}).flatMap(([modelID, model]) => {
      if (!isRecord(model))
        return [];
      return [[modelID, parseModelMetadata(model)]];
    }));
    const npm = typeof provider.npm === "string" ? provider.npm : undefined;
    return npm || Object.keys(models).length > 0 ? [[providerID, { ...npm ? { npm } : {}, models }]] : [];
  }));
}
async function discoverModelMetadata(input) {
  const response = await (input.fetcher ?? fetch)(input.url, {
    signal: AbortSignal.timeout(input.timeoutMs)
  });
  if (!response.ok) {
    const detail = (await response.text()).trim().slice(0, 300);
    throw new Error(`Model metadata discovery failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return parseModelMetadataCatalog(await response.json());
}
function parseModelMetadata(model) {
  const provider = isRecord(model.provider) ? model.provider : undefined;
  const modalities = isRecord(model.modalities) ? model.modalities : undefined;
  const limit = isRecord(model.limit) ? model.limit : undefined;
  const cost = isRecord(model.cost) ? model.cost : undefined;
  const released = typeof model.release_date === "string" ? Date.parse(model.release_date) : Number.NaN;
  const reasoningEfforts = parseReasoningEfforts(model.reasoning_options);
  return {
    ...provider && typeof provider.npm === "string" ? { npm: provider.npm } : {},
    ...typeof model.name === "string" ? { name: model.name } : {},
    ...typeof model.family === "string" ? { family: model.family } : {},
    ...typeof model.tool_call === "boolean" ? { toolCall: model.tool_call } : {},
    ...modalities && isStringArray(modalities.input) && isStringArray(modalities.output) ? { modalities: { input: modalities.input, output: modalities.output } } : {},
    ...limit && typeof limit.context === "number" && typeof limit.output === "number" ? {
      limit: {
        context: limit.context,
        ...typeof limit.input === "number" ? { input: limit.input } : {},
        output: limit.output
      }
    } : {},
    ...cost && typeof cost.input === "number" && typeof cost.output === "number" ? {
      cost: {
        input: cost.input,
        output: cost.output,
        cacheRead: typeof cost.cache_read === "number" ? cost.cache_read : 0,
        cacheWrite: typeof cost.cache_write === "number" ? cost.cache_write : 0
      }
    } : {},
    ...Number.isFinite(released) ? { released } : {},
    ...reasoningEfforts ? { reasoningEfforts } : {}
  };
}
function parseReasoningEfforts(input) {
  if (!Array.isArray(input))
    return;
  for (const option of input) {
    if (!isRecord(option) || option.type !== "effort")
      continue;
    if (isStringArray(option.values) && option.values.length > 0)
      return option.values;
  }
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
function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/local-client.ts
function record(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// src/unified.ts
import { Model as Model2, Provider as Provider2 } from "@opencode/plugin";

// src/index.ts
import { Model, Plugin, Provider } from "@opencode/plugin";

// src/cache.ts
import { createHash } from "crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
var CACHE_VERSION = 1;
var METADATA_TTL_MS = 6 * 60 * 60000;
var CATALOG_TTL_MS = 30000;
var LOCK_STALE_MS = 3 * 60000;
function cacheRoot() {
  return process.env.CLIPROXYAPI_CACHE_DIR ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "opencode2-cliproxyapi");
}
function cacheKey(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
function catalogPath(key, root) {
  return join(root, `catalog-${cacheKey(key)}.json`);
}
function metadataPath(url, root) {
  return join(root, `metadata-${cacheKey(url)}.json`);
}
function lockPath(name, root) {
  return join(root, `${name}.lock`);
}
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return;
  }
}
async function writeJson(path, value) {
  const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify(value));
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isCatalogModel(value) {
  if (!isRecord2(value) || typeof value.id !== "string" || value.id.trim() === "")
    return false;
  if (value.ownedBy !== undefined && typeof value.ownedBy !== "string")
    return false;
  if (value.live === undefined)
    return true;
  if (!isRecord2(value.live))
    return false;
  const live = value.live;
  if (live.name !== undefined && typeof live.name !== "string")
    return false;
  if (live.limit === undefined)
    return true;
  if (!isRecord2(live.limit))
    return false;
  const limit = live.limit;
  return (limit.context === undefined || typeof limit.context === "number") && (limit.output === undefined || typeof limit.output === "number");
}
async function readCatalogCache(key, root = cacheRoot()) {
  const value = await readJson(catalogPath(key, root));
  if (!isRecord2(value) || value.version !== CACHE_VERSION)
    return;
  if (!Array.isArray(value.models) || !value.models.every(isCatalogModel))
    return;
  if (typeof value.fetchedAt !== "number")
    return;
  return { models: value.models, fetchedAt: value.fetchedAt };
}
async function writeCatalogCache(key, models, root = cacheRoot()) {
  const value = {
    version: CACHE_VERSION,
    fetchedAt: Date.now(),
    models
  };
  await writeJson(catalogPath(key, root), value);
}
async function readMetadataCache(url, root = cacheRoot()) {
  const value = await readJson(metadataPath(url, root));
  if (!isRecord2(value) || value.version !== CACHE_VERSION)
    return;
  if (!isRecord2(value.catalog) || typeof value.fetchedAt !== "number")
    return;
  return {
    catalog: value.catalog,
    fetchedAt: value.fetchedAt
  };
}
function metadataCacheIsFresh(fetchedAt, now = Date.now()) {
  return now - fetchedAt < METADATA_TTL_MS;
}
function catalogCacheIsFresh(fetchedAt, now = Date.now()) {
  return now - fetchedAt < CATALOG_TTL_MS;
}
async function writeMetadataCache(url, catalog, root = cacheRoot()) {
  const value = {
    version: CACHE_VERSION,
    fetchedAt: Date.now(),
    catalog
  };
  await writeJson(metadataPath(url, root), value);
}
async function tryAcquire(path) {
  const token = `${process.pid}.${Date.now()}.${Math.random()}`;
  let handle;
  try {
    handle = await open(path, "wx");
  } catch (error) {
    if (isErrno(error, "EEXIST"))
      return;
    throw error;
  }
  try {
    await handle.writeFile(token);
  } catch (error) {
    await unlink(path).catch(() => {});
    throw error;
  } finally {
    await handle.close();
  }
  return async () => {
    const current = await readFile(path, "utf8").catch(() => {
      return;
    });
    if (current === token)
      await unlink(path).catch(() => {});
  };
}
function isErrno(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
async function acquireMetadataLock(url, root = cacheRoot()) {
  const path = lockPath(`metadata-${cacheKey(url)}`, root);
  await mkdir(root, { recursive: true });
  const first = await tryAcquire(path);
  if (first)
    return first;
  let stale = false;
  try {
    const info = await stat(path);
    stale = Date.now() - info.mtimeMs > LOCK_STALE_MS;
  } catch (error) {
    if (!isErrno(error, "ENOENT"))
      throw error;
    stale = true;
  }
  if (!stale)
    return;
  await unlink(path).catch((error) => {
    if (!isErrno(error, "ENOENT"))
      throw error;
  });
  return tryAcquire(path);
}

// src/index.ts
var DEFAULT_BASE_URL = "http://localhost:8317/v1";
var DEFAULT_PROVIDER_ID = "cliproxyapi";
var DEFAULT_PROVIDER_NAME = "CLIProxyAPI";
var DEFAULT_DISCOVERY_TIMEOUT_MS = 1e4;
var DEFAULT_MODEL_METADATA_URL = "https://models.dev/api.json";
var DEFAULT_REFRESH_MS = 5 * 60000;
var METADATA_LOCK_POLL_MS = 50;
var pluginTesting = {
  refresh: undefined,
  settled: Promise.resolve()
};
var CHAT_PACKAGE = "@opencode/ai/providers/openai-compatible";
var RESPONSES_PACKAGE = "@opencode/ai/providers/openai/responses";
var MESSAGES_PACKAGE = "@opencode/ai/providers/anthropic";
var ANTHROPIC_NPM = "@ai-sdk/anthropic";
var DEFAULT_ANTHROPIC_EFFORTS = ["low", "medium", "high"];
var INHERITED_OUTPUT_CONTEXT_DIVISOR = 4;
var src_default = Plugin.define({
  id: "opencode2-cliproxyapi",
  async setup(ctx) {
    if (!ctx.provider) {
      console.warn("[cliproxyapi] this OpenCode server does not expose the provider registry; upgrade to OpenCode 2.0.4 or newer");
      return;
    }
    const options = readOptions(ctx.options);
    const providerID = Provider.ID.make(options.providerID ?? DEFAULT_PROVIDER_ID);
    const existing = await ctx.provider.get({ providerID }).catch(() => {
      return;
    });
    const existingSettings = existing?.data.settings ?? {};
    const baseURL = normalizeBaseURL(options.baseURL ?? process.env.CLIPROXY_BASE_URL ?? stringOption(existingSettings.baseURL) ?? DEFAULT_BASE_URL);
    const apiKey = options.apiKey ?? process.env.CLIPROXY_API_KEY ?? stringOption(existingSettings.apiKey);
    const timeoutMs = options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
    const refreshMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_MS;
    const metadataURL = options.modelMetadataURL ?? DEFAULT_MODEL_METADATA_URL;
    const archiveThread = options.archiveThread ?? true;
    const modelProtocols = options.modelProtocols;
    const catalogCacheKey = baseURL;
    const source = {
      info: {
        ...Provider.Info.empty(providerID),
        name: options.providerName ?? DEFAULT_PROVIDER_NAME,
        activation: "enabled",
        package: options.protocol === "responses" ? RESPONSES_PACKAGE : CHAT_PACKAGE,
        settings: {
          baseURL,
          ...apiKey ? { apiKey } : {}
        }
      },
      models: []
    };
    let catalog = [];
    let metadata = {};
    let registered = false;
    let closed = false;
    let refreshPromise;
    const rebuild = async (reload) => {
      if (closed)
        return;
      source.models = catalog.map((model) => buildModel({ providerID, model, metadata, modelProtocols }));
      if (reload && registered && !closed)
        await ctx.provider.reload();
    };
    const refreshCatalog = async (reload, fresh = false) => {
      let discovered;
      try {
        discovered = await loadCatalog({ baseURL, apiKey, timeoutMs, fresh });
      } catch (error) {
        if (closed)
          return;
        const recovered = await readCatalogCache(catalogCacheKey).catch(() => {
          return;
        });
        if (!recovered?.models.length)
          throw error;
        catalog = recovered.models;
        await rebuild(reload);
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[cliproxyapi] catalog refresh failed, using cached models: ${message}`);
        return;
      }
      catalog = discovered;
      await writeCatalogCache(catalogCacheKey, catalog).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[cliproxyapi] could not update the catalog cache: ${message}`);
      });
      if (closed)
        return;
      await rebuild(reload);
      console.log(`[cliproxyapi] discovered ${catalog.length} models from ${baseURL}`);
    };
    const refreshMetadata = async () => {
      if (metadataURL === false || closed || catalog.length === 0)
        return;
      const result = await loadModelMetadata({
        url: metadataURL,
        timeoutMs,
        isClosed: () => closed
      });
      if (closed || catalog.length === 0)
        return;
      if (result.stale) {
        if (Object.keys(metadata).length > 0 || Object.keys(result.catalog).length === 0)
          return;
      }
      metadata = result.catalog;
      await rebuild(true);
    };
    const [cachedCatalog, cachedMetadata] = await Promise.all([
      readCatalogCache(catalogCacheKey).catch(() => {
        return;
      }),
      metadataURL === false ? Promise.resolve(undefined) : readMetadataCache(metadataURL).catch(() => {
        return;
      })
    ]);
    if (cachedCatalog?.models.length)
      catalog = cachedCatalog.models;
    if (cachedMetadata)
      metadata = cachedMetadata.catalog;
    if (catalog.length > 0)
      await rebuild(false);
    await ctx.provider.transform((editor) => {
      editor.add({ info: source.info, models: source.models });
    });
    registered = true;
    await ctx.session.hook("model.request", (event) => {
      if (apiKey && !hasHeader(event.headers, "authorization")) {
        event.headers.authorization = `Bearer ${apiKey}`;
      }
      if (archiveThread && event.sessionID && !hasHeader(event.headers, "X-Thread-Id")) {
        event.headers["X-Thread-Id"] = event.sessionID;
      }
    }, { providerID });
    const refresh = () => {
      if (closed)
        return Promise.resolve();
      if (refreshPromise)
        return refreshPromise;
      refreshPromise = (async () => {
        try {
          await refreshCatalog(true, true);
          if (closed)
            return;
          await refreshMetadata();
        } finally {
          refreshPromise = undefined;
        }
      })();
      pluginTesting.settled = refreshPromise.catch((error) => {
        console.warn(`[cliproxyapi] catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      return refreshPromise;
    };
    pluginTesting.refresh = refresh;
    refresh();
    const cleanup = () => {
      closed = true;
      if (pluginTesting.refresh === refresh)
        pluginTesting.refresh = undefined;
    };
    if (refreshMs <= 0)
      return cleanup;
    const timer = setInterval(() => {
      refresh();
    }, refreshMs);
    timer.unref?.();
    return () => {
      cleanup();
      clearInterval(timer);
    };
  }
});
function buildModel(input) {
  const modelID = Model.ID.make(input.model.id);
  const resolved = resolveMetadata(input.metadata, input.model);
  const metadata = resolved.metadata;
  const image = isImageModel(input.model.id);
  const anthropic = usesAnthropicMessages(input.model, resolved.npm);
  const protocol = anthropic ? undefined : protocolOverride(input.model.id, input.modelProtocols);
  const responses = protocol === "responses" || protocol !== "chat" && usesResponses(input.model, metadata?.family);
  const efforts = metadata?.reasoningEfforts ?? (anthropic ? [...DEFAULT_ANTHROPIC_EFFORTS] : undefined);
  const defaults = Model.Info.default(input.providerID, modelID);
  const limit = resolveLimit({
    live: input.model.live?.limit,
    catalog: metadata?.limit,
    fallback: defaults.limit
  });
  return {
    ...defaults,
    name: input.model.live?.name ?? metadata?.name ?? displayName(input.model.id),
    ...metadata?.family ? { family: Model.Family.make(metadata.family) } : {},
    ...anthropic ? { package: MESSAGES_PACKAGE } : responses ? { package: RESPONSES_PACKAGE } : protocol === "chat" ? { package: CHAT_PACKAGE } : {},
    capabilities: {
      tools: metadata?.toolCall ?? !image,
      input: metadata?.modalities?.input ?? (image || supportsAttachments(input.model.id) ? ["text", "image"] : ["text"]),
      output: metadata?.modalities?.output ?? (image ? ["image"] : ["text"])
    },
    ...efforts ? {
      variants: efforts.map((effort) => ({
        id: Model.VariantID.make(effort),
        settings: anthropic ? anthropicEffort(effort) : { reasoningEffort: effort }
      }))
    } : {},
    ...limit ? { limit } : {},
    ...metadata?.cost ? {
      cost: [
        {
          input: money(metadata.cost.input),
          output: money(metadata.cost.output),
          cache: {
            read: money(metadata.cost.cacheRead),
            write: money(metadata.cost.cacheWrite)
          }
        }
      ]
    } : {},
    ...metadata?.released ? { time: { released: metadata.released } } : {}
  };
}
function resolveLimit(input) {
  const { live, catalog, fallback } = input;
  if (!live || live.context === undefined && live.output === undefined)
    return catalog;
  const context = live.context ?? catalog?.context ?? fallback.context;
  const inheritedOutput = catalog?.output ?? fallback.output;
  let output;
  if (live.output !== undefined) {
    output = Math.min(live.output, context);
  } else {
    output = Math.min(inheritedOutput, Math.max(1, Math.floor(context / INHERITED_OUTPUT_CONTEXT_DIVISOR)));
  }
  const inheritedInput = catalog?.input;
  const inputLimit = inheritedInput === undefined ? undefined : Math.max(1, Math.min(inheritedInput, context - output));
  return {
    context,
    ...inputLimit !== undefined ? { input: inputLimit } : {},
    output
  };
}
function usesAnthropicMessages(model, npm) {
  return npm === ANTHROPIC_NPM || model.ownedBy === "anthropic";
}
function usesResponses(model, family, modelProtocols) {
  const override = protocolOverride(model.id, modelProtocols);
  if (override === "chat")
    return false;
  if (override === "responses")
    return true;
  const identity = `${family ?? ""} ${modelIdentity(model.id)}`.toLowerCase();
  return /(?:^|[^a-z0-9])(?:codex|grok-[a-z0-9.]+|gpt-(?:[5-9]|[1-9][0-9]+))(?![a-z0-9])/.test(identity);
}
function protocolOverride(modelID, modelProtocols) {
  if (!modelProtocols)
    return;
  const direct = modelProtocols[modelID] ?? modelProtocols[modelIdentity(modelID)];
  return direct === "chat" || direct === "responses" ? direct : undefined;
}
function modelIdentity(modelID) {
  const slash = modelID.lastIndexOf("/");
  return slash === -1 ? modelID : modelID.slice(slash + 1);
}
function anthropicEffort(effort) {
  return {
    thinking: { type: "adaptive", display: "summarized" },
    effort
  };
}
function resolveMetadata(catalog, model) {
  const owner = model.ownedBy ? catalog[model.ownedBy] : undefined;
  const owned = owner?.models[model.id];
  if (owned)
    return { metadata: owned, npm: owned.npm ?? owner?.npm };
  for (const provider of Object.values(catalog)) {
    const metadata = provider.models[model.id];
    if (metadata)
      return { metadata };
  }
  return { npm: owner?.npm };
}
var catalogRequests = new Map;
function loadCatalog(input) {
  const requestKey = `${input.baseURL}\x00${input.apiKey ?? ""}`;
  const existing = catalogRequests.get(requestKey);
  if (existing)
    return existing;
  const pending = (async () => {
    if (!input.fresh) {
      const cached = await readCatalogCache(input.baseURL).catch(() => {
        return;
      });
      if (cached && catalogCacheIsFresh(cached.fetchedAt) && cached.models.length > 0) {
        return cached.models;
      }
    }
    return discoverModels(input);
  })().finally(() => {
    catalogRequests.delete(requestKey);
  });
  catalogRequests.set(requestKey, pending);
  return pending;
}
var metadataRequests = new Map;
function loadModelMetadata(input) {
  if (input.url === false)
    return Promise.resolve({ catalog: {} });
  const url = input.url;
  const existing = metadataRequests.get(url);
  if (existing)
    return existing;
  const pending = discoverSharedMetadata(url, input.timeoutMs, input.isClosed ?? (() => false)).finally(() => {
    metadataRequests.delete(url);
  });
  metadataRequests.set(url, pending);
  return pending;
}
async function discoverSharedMetadata(url, timeoutMs, isClosed) {
  const cached = await readMetadataCache(url).catch(() => {
    return;
  });
  if (cached && metadataCacheIsFresh(cached.fetchedAt))
    return { catalog: cached.catalog };
  let release;
  try {
    release = await acquireMetadataLock(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[cliproxyapi] metadata lock unavailable, downloading anyway: ${message}`);
    return fetchMetadata(url, timeoutMs, cached?.catalog);
  }
  if (!release) {
    const waited = await waitForSharedMetadata(url, timeoutMs, isClosed);
    if (waited && metadataCacheIsFresh(waited.fetchedAt))
      return { catalog: waited.catalog };
    return { catalog: waited?.catalog ?? cached?.catalog ?? {}, stale: true };
  }
  try {
    return await fetchMetadata(url, timeoutMs, cached?.catalog);
  } finally {
    await release();
  }
}
async function fetchMetadata(url, timeoutMs, fallback) {
  try {
    const catalog = await discoverModelMetadata({ url, timeoutMs });
    await writeMetadataCache(url, catalog).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[cliproxyapi] could not update the metadata cache: ${message}`);
    });
    return { catalog };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[cliproxyapi] ${message}`);
    return { catalog: fallback ?? {}, stale: true, error: message };
  }
}
async function waitForSharedMetadata(url, timeoutMs, isClosed) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isClosed())
      return;
    const cached = await readMetadataCache(url).catch(() => {
      return;
    });
    if (cached && metadataCacheIsFresh(cached.fetchedAt))
      return cached;
    await sleep(METADATA_LOCK_POLL_MS);
  }
  return readMetadataCache(url).catch(() => {
    return;
  });
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function readOptions(input) {
  return {
    baseURL: stringOption(input.baseURL),
    apiKey: stringOption(input.apiKey),
    providerID: stringOption(input.providerID),
    providerName: stringOption(input.providerName),
    protocol: input.protocol === "responses" ? "responses" : input.protocol === "chat" ? "chat" : undefined,
    modelProtocols: protocolMap(input.modelProtocols),
    modelMetadataURL: input.modelMetadataURL === false ? false : stringOption(input.modelMetadataURL),
    discoveryTimeoutMs: typeof input.discoveryTimeoutMs === "number" && input.discoveryTimeoutMs > 0 ? input.discoveryTimeoutMs : undefined,
    refreshIntervalMs: typeof input.refreshIntervalMs === "number" && input.refreshIntervalMs >= 0 ? input.refreshIntervalMs : undefined,
    archiveThread: input.archiveThread === false ? false : undefined
  };
}
function stringOption(value) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
function protocolMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return;
  const protocols = {};
  for (const [modelID, protocol] of Object.entries(value)) {
    const id = modelID.trim();
    if (id === "")
      continue;
    if (protocol === "chat" || protocol === "responses")
      protocols[id] = protocol;
  }
  return Object.keys(protocols).length > 0 ? protocols : undefined;
}
function hasHeader(headers, name) {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}
function money(value) {
  return value;
}
function displayName(modelID) {
  return modelID.split("-").map((part) => {
    const lower = part.toLowerCase();
    if (lower === "gpt")
      return "GPT";
    if (lower === "oss")
      return "OSS";
    if (lower === "codex")
      return "Codex";
    return part.charAt(0).toUpperCase() + part.slice(1);
  }).join(" ");
}
function isImageModel(modelID) {
  return /(?:^|-)image(?:-|$)/i.test(modelID);
}
function supportsAttachments(modelID) {
  return /^(?:claude|gemini|gpt)/i.test(modelID);
}

// src/unified.ts
var tail = (id) => id.slice(id.lastIndexOf("/") + 1);
var positive = (v) => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
var intersect = (lists) => lists.length ? [...new Set(lists[0])].filter((x) => lists.every((l) => l.includes(x))) : [];
function rank(m) {
  return m.id.startsWith("shared/") ? 0 : !m.id.includes("/") ? 1 : m.id.startsWith("opencode-go/") ? 2 : 3;
}
function buildUnified(inventory, metadata = {}) {
  const groups = new Map;
  const names = new Map(inventory.aliases.map((a) => [a.name, tail(a.alias)]));
  const definitions = new Map(inventory.definitions.map((m) => [m.id, m]));
  for (const model of inventory.catalog) {
    const id = names.get(model.id) ?? tail(model.id);
    const group = groups.get(id) ?? [];
    group.push(model);
    groups.set(id, group);
  }
  const routes = [];
  const providerID = Provider2.ID.make("models");
  for (const [id, group] of groups) {
    const selected = [...group].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))[0];
    const members = selected.id.startsWith("shared/") ? inventory.aliases.filter((a) => a.alias === selected.id).map((a) => a.name) : [selected.id];
    const defs = members.map((m) => definitions.get(m)).filter((d) => !!d);
    if (!defs.length && definitions.has(selected.id))
      defs.push(definitions.get(selected.id));
    const preferred = defs.find((d) => d.id.startsWith("opencode-go/")) ?? defs[0];
    const fallback = buildModel({ providerID, model: { ...selected, id }, metadata });
    const inputs = defs.filter((d) => d.supportedInputModalities?.length).map((d) => d.supportedInputModalities);
    if (members.some((m) => m.startsWith("commandcode-goat/")))
      inputs.push(["text", "image"]);
    const input = intersect(inputs);
    const output = intersect(defs.filter((d) => d.supportedOutputModalities?.length).map((d) => d.supportedOutputModalities));
    const isClaude = /^claude-/.test(id);
    const isCodex = selected.ownedBy === "openai" && /^(gpt-[5-9]|gpt-\d{2}|codex)/.test(id) && !/image/.test(id);
    const image = /image|dall-e/.test(id) || output.includes("image");
    const name = cleanName(preferred?.display_name || fallback.name || id);
    const contexts = defs.map((d) => d.context_length).filter(positive);
    const outputs = defs.map((d) => d.max_completion_tokens).filter(positive);
    const context = contexts.length ? Math.min(...contexts) : fallback.limit.context;
    const maxOutput = Math.min(outputs.length ? Math.min(...outputs) : fallback.limit.output, context);
    const levels = defs.length && defs.length === members.length && defs.every((d) => d.thinking?.levels?.length) ? intersect(defs.map((d) => d.thinking.levels)) : [];
    if (isClaude && defs.length && defs.every((d) => d.thinking?.zero_allowed || d.thinking?.levels?.includes("none")) && !levels.includes("none"))
      levels.unshift("none");
    const variants = levels.map((effort) => ({ id: Model2.VariantID.make(effort), settings: isClaude ? effort === "none" ? { thinking: { type: "disabled" } } : { thinking: { type: "adaptive" }, effort } : { reasoningEffort: effort } }));
    if (isClaude && !levels.some((e) => e !== "none") && defs.length && defs.every((d) => positive(d.thinking?.min))) {
      const minimum = Math.max(...defs.map((d) => d.thinking.min));
      const ceiling = Math.min(maxOutput - 1, ...defs.map((d) => positive(d.thinking?.max) ? d.thinking.max : 32768));
      if (ceiling >= minimum)
        for (const [effort, budgetTokens] of [["low", minimum], ["medium", Math.min(ceiling, Math.max(minimum, 8192))], ["high", ceiling]])
          variants.push({ id: Model2.VariantID.make(effort), settings: { thinking: { type: "enabled", budgetTokens } } });
    }
    const model = {
      ...fallback,
      id: Model2.ID.make(id),
      modelID: Model2.ID.make(selected.id),
      name,
      package: isClaude ? "@opencode/ai/providers/anthropic" : isCodex ? "@opencode/ai/providers/openai/responses" : "@opencode/ai/providers/openai-compatible",
      compatibility: isClaude || isCodex ? {} : { reasoningField: "reasoning_content", maxTokensField: "max_tokens" },
      capabilities: { tools: !image && fallback.capabilities.tools, input: input.length ? input : fallback.capabilities.input, output: output.length ? output : fallback.capabilities.output },
      variants: variants.length ? variants : fallback.variants,
      limit: { context, output: maxOutput },
      cost: [],
      ...image ? { type: "image" } : {}
    };
    routes.push({ id, name, target: selected.id, members, model });
  }
  return routes.sort((a, b) => a.name.localeCompare(b.name));
}
function cleanName(name) {
  return name.replace(/\s*\((?:shared|opencode go|commandcode goat|openai)\)\s*/gi, " ").replace(/\s+1017\b/g, "").trim();
}

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

// src/remote-client.ts
function normalizeServerURL(input) {
  const value = input.trim();
  let url;
  try {
    url = new URL(value.includes("://") ? value : `https://${value}`);
  } catch {
    throw new Error("Enter a valid CLIProxy base URL");
  }
  if (url.username || url.password || url.search || url.hash)
    throw new Error("Use a base URL without credentials, query parameters or fragments");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const parts = host.split(".").map(Number);
  const tailnet = host.endsWith(".ts.net") || parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127 || host.startsWith("fd7a:115c:a1e0:");
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(host);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (tailnet || loopback)))
    throw new Error("Use HTTPS, or an HTTP address inside Tailscale or localhost");
  const path = url.pathname.replace(/\/+$/, "");
  if (/\.(?:html?|json)$/i.test(path))
    throw new Error("Enter the server base URL, not a dashboard or file URL");
  url.pathname = path.endsWith("/v1") ? path : `${path}/v1`;
  return url.toString().replace(/\/$/, "");
}

class RemoteClient {
  apiKey;
  fetcher;
  baseURL;
  extensionURL;
  constructor(baseURL, apiKey, fetcher = fetch) {
    this.apiKey = apiKey;
    this.fetcher = fetcher;
    this.baseURL = normalizeServerURL(baseURL);
    this.extensionURL = this.baseURL.replace(/\/v1$/, "") + "/opencode/v1";
    if (!apiKey.trim())
      throw new Error("Enter the CLIProxy API key");
  }
  async json(url, signal) {
    const response = await this.fetcher(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000)
    }).catch(() => {
      throw new Error("Cannot reach CLIProxy. Check the URL and your Tailscale connection.");
    });
    if (response.status === 401 || response.status === 403)
      throw new Error("CLIProxy rejected the API key. Reconnect using /connect.");
    if (!response.ok)
      throw new Error(`CLIProxy returned HTTP ${response.status}`);
    return response.json().catch(() => {
      throw new Error("CLIProxy returned an invalid response");
    });
  }
  async inventory() {
    const catalog = parseCatalog(await this.json(`${this.baseURL}/models`));
    try {
      const data = await this.json(`${this.extensionURL}/inventory`);
      if (!record(data) || !Array.isArray(data.definitions) || !Array.isArray(data.aliases))
        throw new Error("Metadata unavailable");
      return {
        catalog,
        definitions: data.definitions,
        aliases: data.aliases,
        routing: record(data.routing) ? data.routing : {},
        fetchedAt: new Date().toISOString(),
        ...typeof data.warning === "string" ? { warning: data.warning } : {}
      };
    } catch {
      return {
        catalog,
        definitions: [],
        aliases: [],
        routing: {},
        fetchedAt: new Date().toISOString(),
        warning: "Connected. Server metadata is temporarily unavailable; using cached or conservative model settings."
      };
    }
  }
  async usage(force = false, signal) {
    const data = await this.json(`${this.extensionURL}/usage${force ? "?refresh=1" : ""}`, signal);
    if (!record(data) || typeof data.text !== "string" || typeof data.fetchedAt !== "string" || !Array.isArray(data.accounts))
      throw new Error("Quota endpoint is unavailable on this server");
    return data;
  }
}

// src/auth.ts
var INTEGRATION_ID = "cliproxy";
var connectionForm = [{
  type: "string",
  key: "baseURL",
  title: "CLIProxy base URL",
  description: "Paste the Tailscale HTTPS URL of your CLIProxy server. /v1 is optional.",
  placeholder: "https://your-computer.your-tailnet.ts.net:8443",
  required: true,
  minLength: 1,
  pattern: "^(https?://)?[^\\s]+$"
}];
async function registerAuth(ctx) {
  await ctx.integration.transform((editor) => {
    editor.update(INTEGRATION_ID, (integration) => {
      integration.name = "CLIProxy";
    });
    editor.method.update({ integrationID: INTEGRATION_ID, method: { type: "key", label: "CLIProxy API key", form: connectionForm } });
  });
}
async function selectedConnection(ctx) {
  const info = await ctx.integration.connection.active(INTEGRATION_ID);
  if (!info)
    return;
  const credential = await ctx.integration.connection.resolve(info);
  if (credential?.type !== "key")
    return;
  const entered = credential.metadata?.baseURL;
  if (typeof entered !== "string")
    throw new Error("Reconnect CLIProxy and enter its base URL");
  const baseURL = normalizeServerURL(entered);
  return { info, baseURL, apiKey: credential.key, client: new RemoteClient(baseURL, credential.key) };
}

// src/server.ts
var server_default = Plugin2.define({
  id: "opencode-cliproxy",
  async setup(ctx) {
    const providerID = Provider3.ID.make("models");
    let closed = false;
    let selected;
    let identity = "";
    let generation = 0;
    let routes = [];
    let cached;
    let fetchedAt = "";
    let message = "Use /connect \u2192 CLIProxy to enter your server URL and API key.";
    let pending;
    const controller = new AbortController;
    const roots = new Map;
    const source = {
      ...Provider3.Info.empty(providerID),
      name: "Models",
      integrationID: Integration.ID.make(INTEGRATION_ID),
      activation: "disabled",
      package: "@opencode/ai/providers/openai-compatible",
      settings: {}
    };
    const apply = (data) => {
      cached = data;
      routes = buildUnified(data);
      fetchedAt = data.fetchedAt;
    };
    await registerAuth(ctx);
    await ctx.provider.transform((editor) => {
      editor.add({ info: source, models: routes.map((r) => r.model), ...selected ? { sourceConnection: selected.info } : {} });
    });
    await ctx.model.transform((editor) => {
      if (!routes.length || !selected || source.activation !== "enabled")
        return;
      if (ctx.options.exclusiveModels !== false) {
        for (const model of editor.list())
          if (model.providerID !== providerID)
            editor.remove(model.providerID, model.id);
      }
      const preferred = routes.find((r) => r.id === "deepseek-v4.1-flash") ?? routes.find((r) => r.model.type !== "image");
      const current = editor.default.get();
      if (preferred && (!current || ctx.options.exclusiveModels !== false && current.providerID !== providerID || current.providerID === providerID && !routes.some((r) => r.id === current.modelID)))
        editor.default.set(providerID, preferred.id);
    });
    const cacheKey = () => "inventory:" + createHash2("sha256").update(identity).digest("hex");
    const refresh = async () => {
      if (closed)
        return;
      let next;
      let selectionError = false;
      try {
        next = await selectedConnection(ctx);
      } catch (error) {
        selectionError = true;
        message = error instanceof Error ? error.message : "Reconnect CLIProxy using /connect.";
        const connection = await ctx.integration.connection.active(INTEGRATION_ID).catch(() => {
          return;
        });
        if (connection)
          await ctx.integration.connection.status({ integrationID: INTEGRATION_ID, connection, status: { status: "needs_auth", message } }).catch(() => {});
      }
      const nextIdentity = next ? `${next.baseURL}\x00${next.info.type === "credential" ? next.info.id : next.info.name}\x00${createHash2("sha256").update(next.apiKey).digest("hex")}` : "";
      if (nextIdentity !== identity) {
        generation++;
        identity = nextIdentity;
        selected = next;
        routes = [];
        cached = undefined;
        fetchedAt = "";
        roots.clear();
        source.activation = "disabled";
        source.settings = next ? { baseURL: next.baseURL, apiKey: next.apiKey } : {};
        if (next) {
          const stored = await ctx.storage.get(cacheKey()).catch(() => {
            return;
          });
          if (record(stored) && Array.isArray(stored.catalog) && Array.isArray(stored.definitions) && Array.isArray(stored.aliases)) {
            try {
              apply(stored);
              source.activation = "enabled";
            } catch {}
          }
        }
        await ctx.provider.reload();
      }
      if (!selected) {
        if (!selectionError)
          message = "Use /connect \u2192 CLIProxy to enter your server URL and API key.";
        return;
      }
      if (pending?.identity === identity)
        return pending.promise;
      const current = selected;
      const stamp = generation;
      const key = cacheKey();
      const operation = (async () => {
        try {
          const data = await current.client.inventory();
          if (closed || stamp !== generation)
            return;
          if (data.warning && cached) {
            if (!data.aliases.length)
              data.aliases = cached.aliases;
            const known = new Set(data.definitions.map((m) => m.id));
            data.definitions.push(...cached.definitions.filter((m) => !known.has(m.id)));
          }
          apply(data);
          source.activation = "enabled";
          message = data.warning ?? `Connected. ${routes.length} models available.`;
          await ctx.integration.connection.status({ integrationID: INTEGRATION_ID, connection: current.info, status: undefined });
          await ctx.storage.set(key, JSON.parse(JSON.stringify(data))).catch(() => {});
          await ctx.provider.reload();
        } catch (error) {
          if (closed || stamp !== generation)
            return;
          message = error instanceof Error ? error.message : "Cannot connect to CLIProxy.";
          const authenticationError = message.includes("rejected the API key");
          if (authenticationError) {
            routes = [];
            cached = undefined;
            source.activation = "disabled";
            await ctx.storage.remove(key).catch(() => {});
          }
          await ctx.integration.connection.status({ integrationID: INTEGRATION_ID, connection: current.info, status: { status: "needs_auth", message } }).catch(() => {});
          await ctx.provider.reload();
        }
      })();
      const entry = { identity, promise: operation };
      pending = entry;
      try {
        await operation;
      } finally {
        if (pending === entry)
          pending = undefined;
      }
    };
    const sessionRoot = async (id) => {
      const known = roots.get(id);
      if (known)
        return known;
      let current = id;
      const visited = [];
      try {
        for (let n = 0;n < 32; n++) {
          visited.push(current);
          const info = await ctx.session.get({ sessionID: current });
          if (!info.parentID || visited.includes(info.parentID))
            break;
          current = roots.get(info.parentID) ?? info.parentID;
          if (roots.has(info.parentID))
            break;
        }
      } catch {
        current = id;
      }
      if (roots.size > 2000)
        roots.clear();
      for (const item of visited)
        roots.set(item, current);
      return current;
    };
    await ctx.session.hook("model.request", async (event) => {
      const current = await selectedConnection(ctx);
      if (!current || current.baseURL !== selected?.baseURL || current.apiKey !== selected?.apiKey)
        throw new Error("CLIProxy connection changed. Refresh models before continuing.");
      event.baseURL = current.baseURL;
      const authorization = Object.keys(event.headers).find((k) => k.toLowerCase() === "authorization") ?? "Authorization";
      event.headers[authorization] = `Bearer ${current.apiKey}`;
      const root = await sessionRoot(event.sessionID);
      for (const name of ["X-Session-Id", "X-Thread-Id"]) {
        const key = Object.keys(event.headers).find((k) => k.toLowerCase() === name.toLowerCase()) ?? name;
        event.headers[key] = root;
      }
    }, { providerID });
    const usage = async (force, signal) => {
      const current = await selectedConnection(ctx);
      if (!current)
        throw new Error("Connect CLIProxy using /connect first.");
      return current.client.usage(force, signal);
    };
    await ctx.rpc.register(LocalRpc, {
      usage: async (input, call) => usage(record(input) && input.force === true, call.signal),
      refresh: async () => {
        await refresh();
        return { models: routes.length, message };
      },
      status: async () => ({ models: routes.length, fetchedAt, message })
    });
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "model_usage",
        description: "Read subscription quotas, reset times and request counts from the connected CLIProxy server. Read-only.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async (_, call) => ({ content: (await usage(false, call.signal)).text })
      });
    });
    await ctx.command.transform((editor) => {
      editor.add({ name: "quota-report", description: "Add the complete usage and quota report to this session", execute: async (input) => {
        let text;
        try {
          text = (await usage(false)).text;
        } catch {
          text = "Quotas are unavailable. Check your CLIProxy connection and Tailscale.";
        }
        await ctx.session.synthetic({ sessionID: input.sessionID, text, description: "Usage and quotas", resume: false });
      } });
    });
    (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if ((event.type === "credential.updated" || event.type === "credential.switched") && event.data.integrationID === INTEGRATION_ID)
            refresh().catch(() => {});
        }
      } catch {}
    })();
    refresh().catch(() => {});
    const timer = setInterval(() => {
      refresh().catch(() => {});
    }, 300000);
    timer.unref?.();
    return () => {
      closed = true;
      controller.abort();
      clearInterval(timer);
    };
  }
});
export {
  server_default as default
};
