// Runs every test/*.test.ts file. npm runs scripts through cmd.exe on Windows, which
// doesn't expand globs, so the file list is built here instead.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const files = readdirSync("test")
  .filter((file) => file.endsWith(".test.ts"))
  .sort()
  .map((file) => join("test", file));

const { status } = spawnSync("npx", ["tsx", "--test", ...files], { stdio: "inherit", shell: true });
process.exit(status ?? 1);
