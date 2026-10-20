import semver from "semver";
import { z } from "zod";
import { ToolError } from "../lib/errors.js";
import { capped, plural, table } from "../lib/format.js";
import { dependents, loadInventory, nameFromPath, shortestChain, type InstalledPackage } from "../lib/inventory.js";
import { loadProject, type PackageManager } from "../lib/project.js";
import type { Advisory, Registry, Severity, VersionInfo } from "../lib/registry.js";
import { defineTool } from "./types.js";

const SEVERITIES: Severity[] = ["info", "low", "moderate", "high", "critical"];
const rank = (severity: Severity) => SEVERITIES.indexOf(severity);

/** The advisory endpoint accepts large bodies, but a monorepo lockfile can list thousands of packages. */
const BATCH_SIZE = 800;

export const auditDependencies = defineTool({
  name: "audit_dependencies",
  title: "Audit dependencies",
  description:
    "Finds installed npm packages with known security advisories and works out the smallest fix for each: " +
    "a lockfile refresh when every dependent's range already allows a patched version, a same-major upgrade, " +
    "an upgrade of the direct dependency that pulls a transitive package in, or a major upgrade when nothing smaller works. " +
    "Every suggested version is checked against all of the package's advisories, not only the installed version's. " +
    "Reads package-lock.json (or node_modules) and the public npm advisory database. Read-only: it never installs or edits anything.",
  network: true,
  inputSchema: {
    projectDir: z.string().optional().describe("Absolute path of the project root. Defaults to the server's working directory."),
    minSeverity: z.enum(["low", "moderate", "high", "critical"]).optional().describe('Hide advisories below this severity (default "low").'),
    includeDev: z.boolean().optional().describe("Include packages only needed by devDependencies (default true)."),
  },
  async run({ projectDir, minSeverity = "low", includeDev = true }, { registry }) {
    const project = await loadProject(projectDir);
    const inventory = await loadInventory(project.dir, project.packageJson);
    if (!inventory) {
      throw new ToolError(
        project.packageManager === "pnpm"
          ? 'pnpm installs into a symlinked store this tool can\'t read yet. Run "pnpm audit --json" instead.'
          : `No package-lock.json and no node_modules in ${project.dir}. Install dependencies first.`,
      );
    }
    const { findings, advisories } = await findVulnerable(inventory.packages, registry);
    const shown = findings.filter(
      (finding) => rank(finding.severity) >= rank(minSeverity) && (includeDev || finding.instances.some((i) => !i.dev)),
    );
    const planner = new FixPlanner(inventory.packages, advisories, registry);
    const fixes = await Promise.all(shown.map((finding) => planner.plan(finding)));
    return report(fixes, { source: inventory.source, packageCount: inventory.packages.size - 1, packageManager: project.packageManager, minSeverity });
  },
});

export interface Instance {
  path: string;
  version: string;
  dev: boolean;
  direct: boolean;
  /** Install paths from a direct dependency down to this package. */
  chain: string[];
  /** Install paths of the packages that depend on this copy ("" is the project), and the range each asked for. */
  requiredBy: { from: string; range: string }[];
}

export interface Finding {
  name: string;
  severity: Severity;
  /** Advisories that affect at least one installed copy. */
  advisories: Advisory[];
  instances: Instance[];
}

/**
 * Every installed package version that an advisory covers, worst first. The advisory
 * endpoint only returns advisories matching the versions it's sent. Planning a fix needs
 * the ones that affect newer versions too, so a second request sends every published
 * version of each vulnerable package.
 */
export async function findVulnerable(
  packages: Map<string, InstalledPackage>,
  registry: Registry,
): Promise<{ findings: Finding[]; advisories: Map<string, Advisory[]> }> {
  const installed = new Map<string, Set<string>>();
  for (const [path, pkg] of packages) {
    if (path === "" || !semver.valid(pkg.version)) continue;
    installed.set(pkg.name, (installed.get(pkg.name) ?? new Set()).add(pkg.version));
  }
  const names = [...installed.keys()];
  const vulnerable = new Set<string>();
  for (let i = 0; i < names.length; i += BATCH_SIZE) {
    const batch = Object.fromEntries(names.slice(i, i + BATCH_SIZE).map((name) => [name, [...installed.get(name)!]]));
    for (const [name, list] of Object.entries(await registry.advisories(batch))) if (list.length) vulnerable.add(name);
  }

  const advisories = new Map<string, Advisory[]>();
  await Promise.all([...vulnerable].map(async (name) => advisories.set(name, await allAdvisories(name, registry))));

  const parents = dependents(packages);
  const root = packages.get("")!;
  const findings: Finding[] = [];
  for (const [name, list] of advisories) {
    const instances: Instance[] = [];
    for (const [path, pkg] of packages) {
      if (path === "" || pkg.name !== name || !list.some((advisory) => affects(advisory, pkg.version))) continue;
      instances.push({
        path,
        version: pkg.version,
        dev: pkg.dev,
        direct: path === `node_modules/${name}` && name in root.dependencies,
        chain: shortestChain(path, parents),
        requiredBy: parents.get(path) ?? [],
      });
    }
    const relevant = list.filter((advisory) => instances.some((instance) => affects(advisory, instance.version)));
    if (!instances.length) continue;
    const severity = relevant.reduce<Severity>((worst, a) => (rank(a.severity) > rank(worst) ? a.severity : worst), "info");
    findings.push({ name, severity, advisories: relevant, instances });
  }
  findings.sort((a, b) => rank(b.severity) - rank(a.severity) || a.name.localeCompare(b.name));
  return { findings, advisories };
}

/** Every advisory for a package, whichever versions it affects. */
async function allAdvisories(name: string, registry: Registry): Promise<Advisory[]> {
  const packument = await registry.packument(name);
  return (await registry.advisories({ [name]: packument.versions.map((v) => v.version) }))[name] ?? [];
}

export function affects(advisory: Advisory, version: string): boolean {
  return semver.satisfies(version, advisory.vulnerable_versions, { includePrerelease: true });
}

export type FixKind = "refresh" | "same-major" | "upgrade-direct" | "major" | "override" | "none";

export interface Fix {
  finding: Finding;
  kind: FixKind;
  /** Lowest stable version of the vulnerable package that no known advisory affects. */
  patched?: string;
  summary: string;
  /** The exact change: a command or a package.json edit. */
  action?: string;
  /** Direct-dependency upgrades this fix needs, for the combined plan. */
  upgrades?: DirectUpgrade[];
}

/**
 * Plans the smallest change that removes every advisory for one package. "Safe" always
 * means no advisory at all affects the version, including ones the installed version
 * isn't affected by, so a suggested upgrade never trades one advisory for another.
 */
export class FixPlanner {
  constructor(
    private readonly packages: Map<string, InstalledPackage>,
    private readonly advisories: Map<string, Advisory[]>,
    private readonly registry: Registry,
  ) {}

  async plan(finding: Finding): Promise<Fix> {
    const safe = await this.safeVersions(finding.name);
    if (!safe) return { finding, kind: "none", summary: `Couldn't load "${finding.name}" from the npm registry to plan a fix.` };
    const lowest = finding.instances.map((i) => i.version).sort(semver.compare)[0]!;
    const patched = safe.find((v) => semver.gt(v.version, lowest))?.version;
    if (!patched) {
      return {
        finding,
        kind: "none",
        summary: "No published version is free of every advisory. Check whether the affected code path is used, replace the package, or accept the risk with a written reason.",
      };
    }

    const direct = finding.instances.find((i) => i.direct);
    if (direct) {
      const target = this.smallestUpgrade(safe, direct.version);
      return {
        finding,
        kind: semver.major(target) === semver.major(direct.version) ? "same-major" : "major",
        patched,
        summary:
          semver.major(target) === semver.major(direct.version)
            ? `Direct dependency. ${target} fixes it without a major version change.`
            : `Direct dependency. The first version free of every advisory is ${target}, a major upgrade from ${direct.version}. Read its changelog and plan for breaking changes.`,
        action: `"${finding.name}": "${target}" in package.json`,
        upgrades: [{ name: finding.name, from: direct.version, version: target, major: semver.major(target) > semver.major(direct.version) }],
      };
    }

    // Transitive. If every dependent's range already allows a safe version, a lockfile refresh is enough.
    const blocked = finding.instances.filter((instance) => instance.requiredBy.some((parent) => !safe.some((v) => semver.satisfies(v.version, parent.range))));
    if (blocked.length === 0) {
      return {
        finding,
        kind: "refresh",
        patched,
        summary: "Every package that depends on it already allows a fixed version, so refreshing the lockfile is enough, with no package.json change.",
        action: `npm update ${finding.name}`,
      };
    }

    // Otherwise the direct dependency at the top of each chain has to move.
    const plans = await Promise.all(unique(blocked, (i) => i.chain[0]!).map((instance) => this.planDirectUpgrade(instance, finding.name)));
    const found = plans.filter((plan): plan is DirectUpgrade => "version" in plan);
    if (found.length === plans.length) {
      return {
        finding,
        kind: "upgrade-direct",
        patched,
        summary: `A dependency's range pins a vulnerable version. Upgrade ${found.map((p) => `${p.name} ${p.from} → ${p.version}${p.major ? " (major)" : ""}`).join(", ")}, the lowest release whose dependency tree allows a fixed ${finding.name}.`,
        action: found.map((p) => `"${p.name}": "${p.version}"`).join(", ") + " in package.json",
        upgrades: found,
      };
    }
    return {
      finding,
      kind: "override",
      patched,
      summary:
        `${plans.map((p) => ("reason" in p ? p.reason : "")).filter(Boolean).join(" ")} ` +
        `An npm "overrides" entry can force ${patched}, but the parent was never released against it, so test carefully, or wait for a fixed release.`,
      action: `"overrides": { "${finding.name}": "${patched}" } in package.json`,
    };
  }

  /** Stable, non-deprecated versions that no known advisory affects, oldest first. */
  private async safeVersions(name: string): Promise<VersionInfo[] | null> {
    const packument = await this.registry.packument(name).catch(() => null);
    if (!packument) return null;
    let list = this.advisories.get(name);
    if (!list) {
      // A package that isn't vulnerable as installed can still have advisories on the versions an upgrade would pick.
      list = await allAdvisories(name, this.registry).catch(() => []);
      this.advisories.set(name, list);
    }
    return stable(packument.versions).filter((v) => !list!.some((a) => affects(a, v.version)));
  }

  /** Same major if possible, otherwise the lowest safe version above the installed one. */
  private smallestUpgrade(safe: VersionInfo[], installed: string): string {
    const above = safe.filter((v) => semver.gt(v.version, installed));
    return (above.find((v) => semver.major(v.version) === semver.major(installed)) ?? above[0]!).version;
  }

  /**
   * Lowest release of the chain's direct dependency whose path down to `vulnerable` can
   * resolve to a safe version, following each intermediate package's declared range to
   * its newest matching release, which is what a fresh install picks.
   */
  private async planDirectUpgrade(instance: Instance, vulnerable: string): Promise<DirectUpgrade | { reason: string }> {
    const topPath = instance.chain[0]!;
    const top = this.packages.get(topPath)!;
    const names = instance.chain.map((path) => this.packages.get(path)!.name);
    const packument = await this.registry.packument(top.name).catch(() => null);
    if (!packument) return { reason: `Couldn't load ${top.name} from the npm registry.` };
    const safeTop = await this.safeVersions(top.name);
    const candidates = (safeTop ?? stable(packument.versions)).filter((v) => semver.gt(v.version, top.version));
    // Releases are checked oldest first; a few dozen covers several majors of a busy package.
    for (const candidate of candidates.slice(0, 60)) {
      if (await this.pathAllowsFix(candidate, names.slice(1), vulnerable)) {
        return { name: top.name, from: top.version, version: candidate.version, major: semver.major(candidate.version) > semver.major(top.version) };
      }
    }
    return { reason: `No release of ${top.name} yet allows a fixed ${vulnerable}.` };
  }

  private async pathAllowsFix(release: VersionInfo, rest: string[], vulnerable: string): Promise<boolean> {
    const [next, ...remaining] = rest;
    if (!next) return true;
    const range = release.dependencies?.[next];
    if (range === undefined) return true; // This release no longer depends on the next package, so the chain is gone.
    if (next === vulnerable) {
      const safe = await this.safeVersions(vulnerable);
      return Boolean(safe?.some((v) => semver.satisfies(v.version, range)));
    }
    const packument = await this.registry.packument(next).catch(() => null);
    const resolved = packument && semver.maxSatisfying(stable(packument.versions).map((v) => v.version), range);
    const info = resolved ? packument!.versions.find((v) => v.version === resolved) : undefined;
    return info ? this.pathAllowsFix(info, remaining, vulnerable) : false;
  }
}

interface DirectUpgrade {
  name: string;
  from: string;
  version: string;
  major: boolean;
}

export interface PlanStep {
  name: string;
  from: string;
  to: string;
  major: boolean;
  /** Vulnerable packages this upgrade resolves. */
  fixes: string[];
}

/**
 * Merges the per-package fixes into one list of direct-dependency changes. When two
 * fixes need different versions of the same dependency (next 15 fixes next itself, but
 * only next 16 ships a fixed postcss), the higher version satisfies both.
 */
export function combinedPlan(fixes: Fix[]): PlanStep[] {
  const steps = new Map<string, PlanStep>();
  const add = (name: string, from: string, to: string, fixed: string) => {
    const step = steps.get(name);
    if (!step) steps.set(name, { name, from, to, major: semver.major(to) > semver.major(from), fixes: [fixed] });
    else {
      if (semver.gt(to, step.to)) Object.assign(step, { to, major: semver.major(to) > semver.major(from) });
      step.fixes.push(fixed);
    }
  };
  for (const fix of fixes) for (const upgrade of fix.upgrades ?? []) add(upgrade.name, upgrade.from, upgrade.version, fix.finding.name);
  return [...steps.values()];
}

function stable(versions: VersionInfo[]): VersionInfo[] {
  return versions.filter((v) => semver.valid(v.version) && !semver.prerelease(v.version) && !v.deprecated).sort((a, b) => semver.compare(a.version, b.version));
}

function unique<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const item of items) if (!seen.has(key(item))) seen.set(key(item), item);
  return [...seen.values()];
}

const ICON: Record<Severity, string> = { critical: "🔴", high: "🟠", moderate: "🟡", low: "⚪", info: "⚪" };
const FIX_LABEL: Record<FixKind, string> = {
  refresh: "Lockfile refresh",
  "same-major": "Same-major upgrade",
  "upgrade-direct": "Upgrade a direct dependency",
  major: "Major upgrade",
  override: "Override (last resort)",
  none: "No fix available",
};

interface ReportContext {
  source: string;
  packageCount: number;
  packageManager: PackageManager;
  minSeverity: Severity;
}

const nameOf = nameFromPath;

export function report(fixes: Fix[], context: ReportContext): string {
  const lines = [`## Dependency audit`, ""];
  lines.push(
    `Checked ${plural(context.packageCount, "installed package")} from ${context.source} against the npm advisory database` +
      (context.minSeverity !== "low" ? ` (showing ${context.minSeverity} and above).` : "."),
    "",
  );
  if (fixes.length === 0) {
    lines.push("No known advisories. 🟢");
    return lines.join("\n");
  }
  const counts = [...SEVERITIES]
    .reverse()
    .map((s) => [s, fixes.filter((f) => f.finding.severity === s).length] as const)
    .filter(([, n]) => n)
    .map(([s, n]) => `${n} ${s}`);
  lines.push(`**${plural(fixes.length, "vulnerable package")}:** ${counts.join(", ")}.`, "");

  const plan = combinedPlan(fixes);
  if (plan.length) {
    lines.push(
      "### Smallest set of package.json changes that fixes everything above",
      "",
      table(["Package", "Change", "Fixes"], plan.map((step) => [`\`${step.name}\``, `${step.from} → ${step.to}${step.major ? " (major)" : ""}`, step.fixes.join(", ")])),
      "",
    );
  }

  lines.push(
    table(
      ["Package", "Severity", "Installed", "Direct?", "Fix", "First safe version"],
      fixes.map((fix) => [
        `\`${fix.finding.name}\``,
        `${ICON[fix.finding.severity]} ${fix.finding.severity}`,
        unique(fix.finding.instances, (i) => i.version).map((i) => i.version).join(", "),
        fix.finding.instances.some((i) => i.direct) ? "direct" : `via ${nameOf(fix.finding.instances[0]!.chain[0]!)}`,
        FIX_LABEL[fix.kind],
        fix.patched ?? "—",
      ]),
    ),
    "",
  );

  for (const fix of fixes) {
    const { finding } = fix;
    const devOnly = finding.instances.every((i) => i.dev);
    lines.push(`### ${ICON[finding.severity]} ${finding.name}${devOnly ? " (dev only)" : ""}`, "");
    lines.push(`**${FIX_LABEL[fix.kind]}.** ${fix.summary}`);
    if (fix.action) lines.push("", `Change: \`${fix.action}\``);
    lines.push("");
    for (const instance of unique(finding.instances, (i) => i.chain.join(">"))) {
      lines.push(`- ${instance.version} at \`${instance.path}\`, pulled in by: ${instance.chain.map(nameOf).join(" → ")}`);
    }
    const advisories = [...finding.advisories].sort((a, b) => rank(b.severity) - rank(a.severity));
    lines.push(...capped(advisories, 5, (a) => `- [${a.title}](${a.url}): ${a.severity}, affects \`${a.vulnerable_versions}\``));
    lines.push("");
  }

  lines.push(
    "How to use this: apply the fixes from the top, smallest change first. After each one, re-run this tool and the project's " +
      "build and tests. A lockfile refresh shouldn't change package.json. A major upgrade needs its changelog read. " +
      (context.packageManager === "npm" || context.packageManager === "unknown"
        ? "`npm audit` reports the same advisories and is the check CI usually runs."
        : `For a ${context.packageManager} project, use the ${context.packageManager} equivalent of each npm command.`),
  );
  return lines.join("\n");
}
