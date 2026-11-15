import { mkdirSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"
const root = resolve(import.meta.dirname, "..")
mkdirSync(resolve(root, "dist"), { recursive: true })
const localBun = resolve(root, "node_modules/bun/bin", process.platform === "win32" ? "bun.exe" : "bun")
const bun = process.env.BUN_BINARY || (existsSync(localBun) ? localBun : "bun")
for (const [command, args] of [
  [bun, ["build", "./src/server.ts", "./src/tui.ts", "./src/rpc.ts", "--outdir", "./dist", "--target", "bun", "--format", "esm", "--external", "@opencode/plugin", "--external", "@opencode/plugin/*"]],
  [bun, ["build", "./src/gateway.ts", "--outdir", "./host", "--target", "node", "--format", "esm"]],
  [process.execPath, ["node_modules/typescript/bin/tsc", "--emitDeclarationOnly"]],
]) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", windowsHide: true })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
