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
export {
  LocalRpc,
  rpc_default as default
};
