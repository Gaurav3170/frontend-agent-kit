import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readJson, type PackageJson } from "./project.js";

/**
 * Every installed package, keyed by its install path ("node_modules/a/node_modules/b"),
 * which is the shape of package-lock.json v2/v3 `packages`. The root project is "".
 */
export interface Inventory {
  source: "package-lock.json" | "node_modules";
  packages: Map<string, InstalledPackage>;
}

export interface InstalledPackage {
  name: string;
  version: string;
  /** Only needed by devDependencies (from the lockfile; unknown, so false, for node_modules scans). */
  dev: boolean;
  /** Declared ranges of everything it depends on at runtime, including optional dependencies. */
  dependencies: Record<string, string>;
}

interface LockEntry {
  name?: string;
  version?: string;
  dev?: boolean;
  link?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface Lockfile {
  lockfileVersion?: number;
  packages?: Record<string, LockEntry>;
}

/**
 * Reads what's installed: package-lock.json when it has the v2/v3 `packages` map (npm 7
 * and later), otherwise the node_modules tree. A node_modules scan works for hoisted
 * layouts (npm, Yarn classic, Bun) but not pnpm's symlinked store, so callers report that.
 */
export async function loadInventory(dir: string, rootPackage: PackageJson): Promise<Inventory | null> {
  const lock = await readJson<Lockfile>(join(dir, "package-lock.json"));
  if (lock?.packages) return { source: "package-lock.json", packages: fromLockfile(lock.packages) };

  const packages = await scanNodeModules(dir);
  if (packages.size === 0) return null;
  packages.set("", rootEntry(rootPackage));
  return { source: "node_modules", packages };
}

export function fromLockfile(entries: Record<string, LockEntry>): Map<string, InstalledPackage> {
  const packages = new Map<string, InstalledPackage>();
  for (const [path, entry] of Object.entries(entries)) {
    if (entry.link || (path !== "" && !entry.version)) continue;
    packages.set(path, {
      name: path === "" ? (entry.name ?? "") : nameFromPath(path),
      version: entry.version ?? "",
      dev: entry.dev === true,
      dependencies: {
        ...entry.dependencies,
        ...entry.optionalDependencies,
        // The root's devDependencies are installed too; nested packages' never are.
        ...(path === "" ? entry.devDependencies : {}),
      },
    });
  }
  return packages;
}

function rootEntry(pkg: PackageJson): InstalledPackage {
  return { name: pkg.name ?? "", version: pkg.version ?? "", dev: false, dependencies: { ...pkg.dependencies, ...pkg.devDependencies } };
}

/** "node_modules/a/node_modules/@scope/b" → "@scope/b". */
export function nameFromPath(path: string): string {
  const index = path.lastIndexOf("node_modules/");
  return path.slice(index + "node_modules/".length);
}

/**
 * Node's lookup: from a package's directory, the nearest node_modules/<name> going up.
 * Returns the install path of the package that `fromPath` gets when it requires `name`.
 */
export function resolveDependency(packages: Map<string, unknown>, fromPath: string, name: string): string | undefined {
  let dir = fromPath;
  for (;;) {
    const candidate = dir ? `${dir}/node_modules/${name}` : `node_modules/${name}`;
    if (packages.has(candidate)) return candidate;
    if (!dir) return undefined;
    const slash = dir.lastIndexOf("/");
    dir = slash === -1 ? "" : dir.slice(0, slash);
  }
}

/** For each install path, the packages that resolve to it, with the range they asked for. */
export function dependents(packages: Map<string, InstalledPackage>): Map<string, { from: string; range: string }[]> {
  const result = new Map<string, { from: string; range: string }[]>();
  for (const [from, pkg] of packages) {
    for (const [name, range] of Object.entries(pkg.dependencies)) {
      const target = resolveDependency(packages, from, name);
      if (!target) continue; // Optional dependency not installed on this platform.
      result.set(target, [...(result.get(target) ?? []), { from, range }]);
    }
  }
  return result;
}

/**
 * Shortest chain of install paths from a direct dependency down to `path`, e.g.
 * ["node_modules/eslint-config-next", "node_modules/@next/eslint-plugin-next", "node_modules/glob"].
 */
export function shortestChain(path: string, parents: Map<string, { from: string }[]>): string[] {
  const previous = new Map<string, string>([[path, ""]]);
  const queue = [path];
  while (queue.length) {
    const current = queue.shift()!;
    if (current === "") break;
    for (const { from } of parents.get(current) ?? []) {
      if (previous.has(from)) continue;
      previous.set(from, current);
      queue.push(from);
    }
  }
  if (!previous.has("")) return [path]; // Orphaned in the lockfile: nothing depends on it.
  const chain: string[] = [];
  for (let step = previous.get("")!; step; step = previous.get(step) ?? "") chain.push(step);
  return chain;
}

async function scanNodeModules(dir: string): Promise<Map<string, InstalledPackage>> {
  const packages = new Map<string, InstalledPackage>();
  const visit = async (relDir: string): Promise<void> => {
    const entries = await readdir(join(dir, relDir), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const names = entry.name.startsWith("@")
        ? (await readdir(join(dir, relDir, entry.name), { withFileTypes: true }).catch(() => []))
            .filter((scoped) => scoped.isDirectory())
            .map((scoped) => `${entry.name}/${scoped.name}`)
        : [entry.name];
      for (const name of names) {
        const path = `${relDir}/${name}`;
        const pkg = await readJson<PackageJson & { optionalDependencies?: Record<string, string> }>(join(dir, path, "package.json")).catch(() => null);
        if (!pkg?.version) continue;
        packages.set(path, { name, version: pkg.version, dev: false, dependencies: { ...pkg.dependencies, ...pkg.optionalDependencies } });
        await visit(`${path}/node_modules`);
      }
    }
  };
  await visit("node_modules");
  return packages;
}
