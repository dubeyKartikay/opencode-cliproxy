import { mkdirSync, rmSync, existsSync } from "node:fs"
import { resolve, sep } from "node:path"
import { spawnSync } from "node:child_process"
const root = resolve(import.meta.dirname, "..")
const temporary = resolve(root, ".test-tmp")
if (!temporary.startsWith(root + sep)) throw new Error("Unsafe test directory")
mkdirSync(temporary, { recursive: true })
const localBun = resolve(root, "node_modules/bun/bin", process.platform === "win32" ? "bun.exe" : "bun")
const bun = process.env.BUN_BINARY || (existsSync(localBun) ? localBun : "bun")
const result = spawnSync(bun, ["test", "./src", ...process.argv.slice(2)], { cwd: root, stdio: "inherit", windowsHide: true,
  env: { ...process.env, TMP: temporary, TEMP: temporary, TMPDIR: temporary } })
rmSync(temporary, { recursive: true, force: true })
process.exit(result.status ?? 1)
