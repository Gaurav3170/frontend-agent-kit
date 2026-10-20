import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { ToolError } from "./errors.js";

export interface PackageJson {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  engines?: Record<string, string>;
}

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "unknown";

export interface Project {
  /** Absolute path of the directory that holds package.json. */
  dir: string;
  packageJson: PackageJson;
  packageManager: PackageManager;
}

/**
 * Resolves the project the agent asked about. Tools take an optional `projectDir`
 * because an MCP server's working directory isn't guaranteed to be the user's project.
 */
export async function loadProject(projectDir: string | undefined): Promise<Project> {
  const dir = resolve(projectDir ?? process.cwd());
  if (projectDir && !isAbsolute(projectDir)) {
    // Relative paths resolve against the server's cwd, which the agent can't see.
    throw new ToolError(`projectDir must be an absolute path, got "${projectDir}".`);
  }
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) throw new ToolError(`${dir} is not a directory.`);

  const packageJson = await readJson<PackageJson>(join(dir, "package.json"));
  if (!packageJson) {
    throw new ToolError(`No package.json in ${dir}. Pass the root of a JavaScript project as projectDir.`);
  }
  return { dir, packageJson, packageManager: detectPackageManager(dir) };
}

export function detectPackageManager(dir: string): PackageManager {
  if (existsSync(join(dir, "package-lock.json"))) return "npm";
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) return "bun";
  return "unknown";
}

/** Declared range from dependencies or devDependencies, e.g. "^14.2.0". */
export function declaredRange(packageJson: PackageJson, name: string): string | undefined {
  return packageJson.dependencies?.[name] ?? packageJson.devDependencies?.[name];
}

/** The package.json of an installed dependency, or null when it isn't installed. */
export function readInstalledPackage(dir: string, name: string): Promise<PackageJson | null> {
  return readJson<PackageJson>(join(dir, "node_modules", name, "package.json"));
}

export async function readJson<T>(path: string): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new ToolError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
}
