import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after } from "node:test";
import type { Result } from "lighthouse";
import type { LighthouseRunner } from "../src/lib/lighthouse.js";
import type { Advisory, Packument, Registry, VersionInfo } from "../src/lib/registry.js";
import type { ToolDeps } from "../src/tools/types.js";

const created: string[] = [];
after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

/**
 * A temporary project from a map of relative path → content. Objects are written as
 * JSON; Buffers as-is. Removed when the test file finishes.
 */
export function project(files: Record<string, string | object | Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), "fak-"));
  created.push(dir);
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, Buffer.isBuffer(content) ? content : typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

/** Bytes that gzip can't shrink, so a fixture's gzip size is close to its raw size. */
export function incompressible(bytes: number): Buffer {
  return randomBytes(bytes);
}

export interface FakePackage {
  versions: (string | VersionInfo)[];
  latest?: string;
  advisories?: Advisory[];
}

/** An in-memory registry; advisories behave like the real endpoint and only return matches for the versions sent. */
export function fakeRegistry(packages: Record<string, FakePackage>): Registry & { advisoryCalls: number } {
  const semverMatch = async () => (await import("semver")).default;
  const registry = {
    advisoryCalls: 0,
    async packument(name: string): Promise<Packument> {
      const pkg = packages[name];
      if (!pkg) throw new Error(`"${name}" is not on the public npm registry.`);
      const versions = pkg.versions.map((v) => (typeof v === "string" ? { version: v } : v));
      return { name, distTags: { latest: pkg.latest ?? versions[versions.length - 1]!.version }, versions };
    },
    async advisories(query: Record<string, string[]>): Promise<Record<string, Advisory[]>> {
      registry.advisoryCalls++;
      const semver = await semverMatch();
      const result: Record<string, Advisory[]> = {};
      for (const [name, versions] of Object.entries(query)) {
        const matching = (packages[name]?.advisories ?? []).filter((a) => versions.some((v) => semver.valid(v) && semver.satisfies(v, a.vulnerable_versions)));
        if (matching.length) result[name] = matching;
      }
      return result;
    },
  };
  return registry;
}

export function advisory(id: number, severity: Advisory["severity"], range: string, title = `Advisory ${id}`): Advisory {
  return { id, severity, vulnerable_versions: range, title, url: `https://github.com/advisories/GHSA-${id}` };
}

export function deps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  return {
    registry: fakeRegistry({}),
    lighthouse: (async () => {
      throw new Error("Lighthouse should not run in this test");
    }) as LighthouseRunner,
    nodeVersion: "20.18.0",
    ...overrides,
  };
}

/** A minimal Lighthouse result with only the fields the report reads. */
export function lhr(overrides: Partial<Result> = {}): Result {
  return {
    lighthouseVersion: "12.8.2",
    requestedUrl: "http://localhost:3000/",
    finalDisplayedUrl: "http://localhost:3000/",
    runWarnings: [],
    categories: {},
    audits: {},
    ...overrides,
  } as unknown as Result;
}
