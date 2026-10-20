/**
 * The two npm registry endpoints the tools need: per-version package metadata, and
 * security advisories. Both go to the public registry. Private registries often don't
 * implement the advisory endpoint, and public packages have the same metadata on both.
 */

export const REGISTRY_URL = "https://registry.npmjs.org";

const TIMEOUT_MS = 60_000;

export interface VersionInfo {
  version: string;
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  deprecated?: string;
}

export interface Packument {
  name: string;
  distTags: Record<string, string>;
  versions: VersionInfo[];
}

export interface Advisory {
  id: number;
  url: string;
  title: string;
  severity: Severity;
  /** Semver range of affected versions, e.g. ">=13.0.0 <15.5.16". */
  vulnerable_versions: string;
}

export type Severity = "info" | "low" | "moderate" | "high" | "critical";

/** What the tools need from the registry; tests pass a fake. */
export interface Registry {
  packument(name: string): Promise<Packument>;
  /** Advisories for each package that affect any of the given versions. */
  advisories(versions: Record<string, string[]>): Promise<Record<string, Advisory[]>>;
}

interface RawPackument {
  name: string;
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, VersionInfo>;
}

export function createRegistry(baseUrl = REGISTRY_URL): Registry {
  const cache = new Map<string, Promise<Packument>>();
  return {
    packument(name) {
      let pending = cache.get(name);
      if (!pending) {
        pending = fetchPackument(baseUrl, name);
        // A failed lookup shouldn't stick: the next call retries.
        pending.catch(() => cache.delete(name));
        cache.set(name, pending);
      }
      return pending;
    },
    async advisories(versions) {
      const response = await fetch(`${baseUrl}/-/npm/v1/security/advisories/bulk`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(versions),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`The npm advisory endpoint returned ${response.status} ${response.statusText}.`);
      return (await response.json()) as Record<string, Advisory[]>;
    },
  };
}

async function fetchPackument(baseUrl: string, name: string): Promise<Packument> {
  // The abbreviated document has everything per version that installs need (engines,
  // dependencies, peers, deprecation) and is a fraction of the full one's size.
  const response = await fetch(`${baseUrl}/${name.replace("/", "%2F")}`, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 404) throw new Error(`"${name}" is not on the public npm registry.`);
  if (!response.ok) throw new Error(`The npm registry returned ${response.status} for "${name}".`);
  const raw = (await response.json()) as RawPackument;
  return {
    name: raw.name,
    distTags: raw["dist-tags"] ?? {},
    versions: Object.values(raw.versions ?? {}),
  };
}
