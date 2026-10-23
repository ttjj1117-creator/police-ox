// Keep the existing smoke-check entry point using isolated, maintained PWA tests.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const root = fileURLToPath(new URL("..", import.meta.url));
const result = spawnSync(
  process.execPath,
  [resolve(root, "scripts/run-e2e.cjs"), "--grep", "PWA", "--reporter=line"],
  { cwd: root, env: process.env, stdio: "inherit" },
);
if (result.error) {
  console.error(result.error.message);
  process.exitCode = 1;
} else process.exitCode = result.status ?? 1;
