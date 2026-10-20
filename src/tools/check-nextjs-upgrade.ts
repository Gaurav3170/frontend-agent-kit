import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import semver from "semver";
import { z } from "zod";
import { ToolError } from "../lib/errors.js";
import { capped, table } from "../lib/format.js";
import { displayPath, lineAt, walk } from "../lib/files.js";
import { declaredRange, loadProject, readInstalledPackage, type PackageJson } from "../lib/project.js";
import type { Registry, VersionInfo } from "../lib/registry.js";
import { defineTool } from "./types.js";

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".scss", ".sass", ".css"]);
const CONFIG_FILES = ["next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs"];
const MAX_LOCATIONS = 8;

export const checkNextjsUpgrade = defineTool({
  name: "check_nextjs_upgrade",
  title: "Check Next.js upgrade",
  description:
    "Prepares a Next.js major upgrade. It reads the project's current Next.js, React and Node.js versions, the target's " +
    "requirements from the npm registry, and every dependency whose peer range rejects the target React. It then scans the source for " +
    "each breaking change between the two versions that a static check can find, with file:line locations: synchronous " +
    "params, searchParams, cookies() and headers(), middleware → proxy, next lint, a custom webpack config under Turbopack, " +
    "runtime config, AMP, next/legacy/image, images.domains, Sass ~ imports, revalidateTag and scroll-behavior. " +
    "It lists the official codemods to run in order. Read-only: it changes nothing.",
  network: true,
  inputSchema: {
    projectDir: z.string().optional().describe("Absolute path of the project root. Defaults to the server's working directory."),
    targetMajor: z
      .number()
      .int()
      .min(13)
      .optional()
      .describe("Next.js major version to upgrade to (default: the latest release)."),
  },
  async run({ projectDir, targetMajor }, { registry, nodeVersion }) {
    const project = await loadProject(projectDir);
    const range = declaredRange(project.packageJson, "next");
    if (!range) throw new ToolError(`${project.dir}/package.json has no "next" dependency.`);
    const installed = (await readInstalledPackage(project.dir, "next"))?.version ?? semver.minVersion(range)?.version;
    if (!installed) throw new ToolError(`Can't tell which Next.js version is installed ("next": "${range}"). Install dependencies first.`);

    const next = await registry.packument("next");
    const target = pickTarget(next.versions, next.distTags["latest"]!, targetMajor);
    if (!target) throw new ToolError(`No stable Next.js ${targetMajor}.x release on npm.`);
    if (semver.major(target.version) <= semver.major(installed)) {
      return `Next.js ${installed} is already on major ${semver.major(installed)}. For a minor or patch update, run \`npx @next/codemod upgrade minor\` (or \`patch\`).`;
    }

    const react = await registry.packument("react");
    const targetReact = pickReact(react.versions, target);
    const context: Context = {
      dir: project.dir,
      packageJson: project.packageJson,
      from: semver.major(installed),
      to: semver.major(target.version),
      sources: await readSources(project.dir),
    };
    const findings = scanForBreakingChanges(context);
    const peers = targetReact ? await peerConflicts(project.dir, project.packageJson, targetReact, registry) : [];
    return report({ installed, target, targetReact, nodeVersion, packageJson: project.packageJson, findings, peers, from: context.from, to: context.to });
  },
});

/** Latest stable release of the requested major, or the `latest` dist-tag. */
export function pickTarget(versions: VersionInfo[], latest: string, major?: number): VersionInfo | undefined {
  if (major === undefined) return versions.find((v) => v.version === latest);
  return versions
    .filter((v) => semver.valid(v.version) && !semver.prerelease(v.version) && semver.major(v.version) === major)
    .sort((a, b) => semver.rcompare(a.version, b.version))[0];
}

/** Next 15 and later need React 19 for the App Router; the latest React the target's peer range allows. */
function pickReact(versions: VersionInfo[], target: VersionInfo): string | undefined {
  const peer = target.peerDependencies?.["react"];
  if (!peer) return undefined;
  const stable = versions.map((v) => v.version).filter((v) => semver.valid(v) && !semver.prerelease(v));
  const wanted = semver.major(target.version) >= 15 ? stable.filter((v) => semver.major(v) >= 19) : stable;
  return semver.maxSatisfying(wanted, peer) ?? undefined;
}

interface Source {
  path: string;
  text: string;
}

interface Context {
  dir: string;
  packageJson: PackageJson;
  from: number;
  to: number;
  sources: Source[];
}

export interface Finding {
  /** The major version that introduced the change. */
  since: number;
  title: string;
  /** What breaks and what to do, in one or two sentences. */
  detail: string;
  locations: string[];
  /** A codemod that fixes it, when one exists. */
  codemod?: string;
}

async function readSources(dir: string): Promise<Source[]> {
  const { files } = await walk(dir, SOURCE_EXTENSIONS);
  const sources: Source[] = [];
  for (const file of files) {
    const text = await readFile(file, "utf8").catch(() => null);
    if (text !== null) sources.push({ path: displayPath(dir, file), text });
  }
  return sources;
}

/** Every location in the sources matching `pattern`, as "path:line". */
function find(sources: Source[], pattern: RegExp, fileFilter: (path: string) => boolean = () => true): string[] {
  const hits: string[] = [];
  for (const source of sources) {
    if (!fileFilter(source.path)) continue;
    for (const match of source.text.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))) {
      hits.push(`${source.path}:${lineAt(source.text, match.index!)}`);
    }
  }
  return hits;
}

const isAppRouterFile = (path: string) => /(^|\/)app\/.*\/?(page|layout|route|default|opengraph-image|twitter-image|icon|apple-icon|sitemap)\.(js|jsx|ts|tsx)$/.test(path);
const isConfig = (path: string) => CONFIG_FILES.includes(path);
const isScript = (path: string) => /\.(js|jsx|ts|tsx|mjs|cjs)$/.test(path);

/** Breaking changes from the official upgrade guides that a text scan can find reliably. */
export function scanForBreakingChanges({ dir, packageJson, from, to, sources }: Context): Finding[] {
  const crosses = (major: number) => from < major && to >= major;
  const findings: Finding[] = [];
  const add = (finding: Finding) => {
    if (finding.locations.length) findings.push(finding);
  };

  if (crosses(15)) {
    // Destructured ({ params }) or typed as a plain object: both mean synchronous access.
    add({
      since: 15,
      title: "Synchronous params / searchParams",
      detail:
        "`params` and `searchParams` are Promises from Next.js 15. Next.js 15 still allows synchronous access with a warning; Next.js 16 removes it. Await them in Server Components, or unwrap them with `React.use()` in Client Components.",
      // Typed as a plain object, or read without awaiting (`params.slug`, not `props.params`).
      // Destructuring alone looks the same in both versions, so it isn't a signal on its own.
      locations: find(sources, /\b(params|searchParams)\s*:\s*\{|(?<![.\w])(params|searchParams)\.\w+/, (p) => isAppRouterFile(p)).filter(unique()),
      codemod: "npx @next/codemod@latest next-async-request-api .",
    });
    add({
      since: 15,
      title: "Synchronous cookies() / headers() / draftMode()",
      detail: "These return Promises from Next.js 15 and must be awaited. Next.js 16 removes the synchronous form.",
      locations: find(sources, /(?<!await\s)(?<!await\s\()\b(cookies|headers|draftMode)\(\)\s*\./, isScript),
      codemod: "npx @next/codemod@latest next-async-request-api .",
    });
    add({
      since: 15,
      title: "fetch and GET route handlers are no longer cached by default",
      detail:
        "In Next.js 14, `fetch` in Server Components and `GET` route handlers were cached by default. From 15 they aren't. Add `cache: 'force-cache'` or `export const dynamic = 'force-static'` where a response should stay cached.",
      locations: find(sources, /export\s+(async\s+)?function\s+GET\b/, (p) => /(^|\/)app\/.*route\.(js|ts)$/.test(p) && !/force-static/.test(sources.find((s) => s.path === p)!.text)),
    });
    add({
      since: 15,
      title: "Renamed config options",
      detail: "`experimental.serverComponentsExternalPackages` is now `serverExternalPackages`, and `experimental.bundlePagesExternals` is now `bundlePagesRouterDependencies`.",
      locations: find(sources, /serverComponentsExternalPackages|bundlePagesExternals/, isConfig),
    });
    add({
      since: 15,
      title: "@next/font removed",
      detail: "Use the built-in `next/font`.",
      locations: find(sources, /from\s+["']@next\/font/, isScript),
      codemod: "npx @next/codemod@latest built-in-next-font .",
    });
    add({
      since: 15,
      title: "NextRequest geo and ip removed",
      detail: "Your hosting provider supplies these now. On Vercel, use `geolocation()` and `ipAddress()` from `@vercel/functions`.",
      locations: find(sources, /\b(req|request)\.(geo|ip)\b/, isScript),
      codemod: "npx @next/codemod@latest next-request-geo-ip .",
    });
    add({
      since: 15,
      title: 'runtime = "experimental-edge"',
      detail: 'Next.js 15 rejects this value. Use `"edge"`.',
      locations: find(sources, /runtime\s*=\s*["']experimental-edge["']/, isScript),
      codemod: "npx @next/codemod@latest app-dir-runtime-config-experimental-edge .",
    });
  }

  if (crosses(16)) {
    const middleware = ["middleware.ts", "middleware.js", "src/middleware.ts", "src/middleware.js"].filter((file) => existsSync(join(dir, file)));
    add({
      since: 16,
      title: "middleware → proxy",
      detail:
        "The `middleware` file and export are renamed to `proxy`. `proxy` always runs on the Node.js runtime, so if this middleware sets `runtime = 'edge'`, keep it as `middleware` for now.",
      locations: middleware,
      codemod: "npx @next/codemod@latest middleware-to-proxy .",
    });
    const lint = Object.entries(packageJson.scripts ?? {})
      .filter(([, command]) => /\bnext lint\b/.test(command))
      .map(([name]) => `package.json scripts.${name}`);
    add({
      since: 16,
      title: "next lint removed",
      detail: "`next lint` is gone, and `next build` no longer lints. Run ESLint (or Biome) directly. `eslint-config-next@16` needs ESLint 9 or later and flat config.",
      locations: [...lint, ...[".eslintrc.json", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc"].filter((file) => existsSync(join(dir, file))).map((f) => `${f} (legacy config format)`)],
      codemod: "npx @next/codemod@canary next-lint-to-eslint-cli .",
    });
    add({
      since: 16,
      title: "Custom webpack config with Turbopack as the default",
      detail:
        "`next build` uses Turbopack from Next.js 16 and fails if it finds a `webpack` config. Move the config to `turbopack` options, or keep Webpack with `next build --webpack`.",
      locations: find(sources, /\bwebpack\s*[:(]/, isConfig),
    });
    add({
      since: 16,
      title: "experimental.turbopack moved",
      detail: "`experimental.turbopack` is now the top-level `turbopack` option.",
      locations: find(sources, /experimental\s*:\s*\{[^}]*turbopack\s*:/s, isConfig),
      codemod: "npx @next/codemod@canary upgrade latest",
    });
    add({
      since: 16,
      title: "Runtime config removed",
      detail: "`serverRuntimeConfig`, `publicRuntimeConfig` and `getConfig()` from `next/config` are removed. Use environment variables, with the `NEXT_PUBLIC_` prefix for client values.",
      locations: [...find(sources, /serverRuntimeConfig|publicRuntimeConfig/, isConfig), ...find(sources, /from\s+["']next\/config["']/, isScript)],
    });
    add({
      since: 16,
      title: "AMP removed",
      detail: "Every AMP API is removed: `next/amp`, `useAmp` and `config = { amp: true }`.",
      locations: [...find(sources, /from\s+["']next\/amp["']|\bamp\s*:\s*true\b/, isScript), ...find(sources, /\bamp\s*:/, isConfig)],
    });
    add({
      since: 16,
      title: "next/legacy/image deprecated",
      detail: "Use `next/image`.",
      locations: find(sources, /from\s+["']next\/legacy\/image["']/, isScript),
    });
    add({
      since: 16,
      title: "images.domains deprecated",
      detail: "Use `images.remotePatterns`. Next.js 16 also changes image defaults: `minimumCacheTTL` goes to 4 hours, `qualities` to `[75]`, 16 is dropped from `imageSizes`, at most 3 redirects are followed, and local IPs are blocked.",
      locations: find(sources, /\bdomains\s*:\s*\[/, isConfig),
    });
    add({
      since: 16,
      title: "Sass ~ imports",
      detail: "Turbopack doesn't support the `~` prefix for imports from node_modules. Drop the `~`.",
      locations: find(sources, /@(import|use|forward)\s+["']~/, (p) => /\.(scss|sass)$/.test(p)),
    });
    add({
      since: 16,
      title: "revalidateTag needs a cacheLife profile",
      detail: "`revalidateTag(tag)` with one argument is deprecated. Pass a profile, e.g. `revalidateTag(tag, 'max')`, or use `updateTag` in Server Actions for read-your-writes.",
      locations: find(sources, /revalidateTag\(\s*[^,()]+\)/, isScript),
    });
    add({
      since: 16,
      title: "unstable_ APIs that are now stable",
      detail: "`unstable_cacheLife` and `unstable_cacheTag` lost the prefix, and `unstable_rootParams` was removed in favour of `next/root-params`.",
      locations: find(sources, /unstable_(cacheLife|cacheTag|rootParams)/, isScript),
      codemod: "npx @next/codemod@latest remove-unstable-prefix .",
    });
    add({
      since: 16,
      title: "experimental.ppr, dynamicIO and useCache removed",
      detail: "Use `cacheComponents`. This isn't a rename: enabling it changes how data is cached. Remove the flags unless you're adopting Cache Components.",
      locations: [...find(sources, /\b(ppr|dynamicIO|useCache)\s*:/, isConfig), ...find(sources, /experimental_ppr/, isScript)],
      codemod: "npx @next/codemod@latest remove-experimental-ppr .",
    });
    add({
      since: 16,
      title: "Parallel route slots need default.js",
      detail: "Every `@slot` folder needs a `default.js`, or the build fails. One that returns `null` or calls `notFound()` keeps the old behaviour.",
      locations: parallelSlotsWithoutDefault(sources),
    });
    add({
      since: 16,
      title: "scroll-behavior: smooth is no longer overridden",
      detail:
        'Next.js used to switch smooth scrolling off during route changes. From 16 it leaves it on, so navigations scroll smoothly to the top. Add `data-scroll-behavior="smooth"` to `<html>` to keep the old behaviour.',
      locations: find(sources, /scroll-behavior\s*:\s*smooth/, (p) => /\.(css|scss|sass)$/.test(p)),
    });
  }
  return findings;
}

function parallelSlotsWithoutDefault(sources: Source[]): string[] {
  const slots = new Set<string>();
  for (const { path } of sources) {
    // The slot is the first @folder under app/, e.g. "src/app/@modal" from "src/app/@modal/login/page.tsx".
    const match = path.match(/^((?:.*\/)?app\/(?:[^@/][^/]*\/)*@[^/]+)\//);
    if (match) slots.add(match[1]!);
  }
  return [...slots].filter((slot) => !sources.some((s) => new RegExp(`^${escape(slot)}/default\\.(js|jsx|ts|tsx)$`).test(s.path)));
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unique() {
  const seen = new Set<string>();
  return (item: string) => (seen.has(item) ? false : (seen.add(item), true));
}

export interface PeerConflict {
  name: string;
  installed: string;
  range: string;
  /** Lowest version whose react peer range accepts the target React, if one exists. */
  fixedIn?: string;
}

/** Direct dependencies whose installed version's react peer range rejects the target React. */
export async function peerConflicts(dir: string, packageJson: PackageJson, targetReact: string, registry: Registry): Promise<PeerConflict[]> {
  const conflicts: PeerConflict[] = [];
  const names = Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies }).filter((name) => !["next", "react", "react-dom"].includes(name) && !name.startsWith("@types/"));
  for (const name of names) {
    const installed = await readInstalledPackage(dir, name);
    const range = installed?.peerDependencies?.["react"];
    if (!installed?.version || !range || semver.satisfies(targetReact, range)) continue;
    const packument = await registry.packument(name).catch(() => null);
    const fixedIn = packument?.versions
      .filter((v) => semver.valid(v.version) && !semver.prerelease(v.version) && semver.gt(v.version, installed.version!) && v.peerDependencies?.["react"] && semver.satisfies(targetReact, v.peerDependencies["react"]))
      .sort((a, b) => semver.compare(a.version, b.version))[0]?.version;
    conflicts.push({ name, installed: installed.version, range, fixedIn });
  }
  return conflicts;
}

interface ReportInput {
  installed: string;
  target: VersionInfo;
  targetReact?: string;
  nodeVersion: string;
  packageJson: PackageJson;
  findings: Finding[];
  peers: PeerConflict[];
  from: number;
  to: number;
}

export function report({ installed, target, targetReact, nodeVersion, packageJson, findings, peers, from, to }: ReportInput): string {
  const lines = [`## Next.js upgrade check: ${installed} → ${target.version}`, ""];

  const nodeRange = target.engines?.["node"];
  const nodeOk = nodeRange ? semver.satisfies(nodeVersion, nodeRange) : true;
  const currentReact = declaredRange(packageJson, "react");
  const typescript = declaredRange(packageJson, "typescript");
  const reactMin = currentReact && semver.validRange(currentReact) ? semver.minVersion(currentReact)?.version : undefined;
  const reactOk = !targetReact || (reactMin !== undefined && semver.major(reactMin) >= semver.major(targetReact));
  const requirements: string[][] = [
    ["Node.js", nodeVersion, nodeRange ?? "—", nodeOk ? "🟢" : "🔴 upgrade Node.js first, locally, in CI and in the deploy image"],
    ["React", currentReact ?? "not declared", targetReact ?? "—", reactOk ? "🟢" : `🟡 upgrade to ${targetReact} (with @types/react, @types/react-dom)`],
  ];
  if (to >= 16 && typescript) {
    const min = semver.minVersion(typescript)?.version ?? "0.0.0";
    requirements.push(["TypeScript", typescript, ">=5.1.0", semver.gte(min, "5.1.0") ? "🟢" : "🔴 upgrade TypeScript"]);
  }
  lines.push("### Requirements", "", table(["", "Now", "Target needs", ""], requirements), "");
  if (to >= 16) lines.push("Next.js 16 supports Chrome, Edge and Firefox 111+, and Safari 16.4+.", "");

  if (peers.length) {
    lines.push(`### Dependencies that reject React ${targetReact}`, "");
    lines.push(
      table(
        ["Package", "Installed", "react peer range", "Fix"],
        peers.map((p) => [`\`${p.name}\``, p.installed, `\`${p.range}\``, p.fixedIn ? `upgrade to ${p.fixedIn}${semver.major(p.fixedIn) > semver.major(p.installed) ? " (major)" : ""}` : "no compatible release"]),
      ),
      "",
      "Upgrade these in the same change as React. Otherwise the install fails, or needs `--legacy-peer-deps`, which hides real incompatibilities.",
      "",
    );
  }

  lines.push(`### Breaking changes found in this code (${findings.length})`, "");
  if (!findings.length) lines.push("None of the changes this tool can detect statically apply. Still read the guides below.", "");
  for (const finding of findings) {
    lines.push(`#### ${finding.title} (Next.js ${finding.since})`, "", finding.detail);
    if (finding.codemod) lines.push("", `Codemod: \`${finding.codemod}\``);
    lines.push("", ...capped(finding.locations, MAX_LOCATIONS, (l) => `- \`${l}\``), "");
  }

  const steps = [
    nodeOk ? undefined : `Upgrade Node.js to a version matching \`${nodeRange}\`.`,
    `Start from a clean branch, and confirm the build and tests pass before changing anything.`,
    `Upgrade one major at a time${to - from > 1 ? `: ${Array.from({ length: to - from }, (_, i) => from + i + 1).join(", then ")}` : ""}. Run \`npx @next/codemod@latest upgrade ${to - from > 1 ? from + 1 : to}\`, which updates next, react and react-dom and offers the codemods for that version.`,
    "Run any codemod listed above that the upgrade didn't apply. Then search for `@next-codemod-error` comments and `UnsafeUnwrapped` casts and resolve each one by hand.",
    peers.length ? "Upgrade the dependencies listed under React." : undefined,
    "Run the type check, lint, tests and production build, then start the production server and click through the main routes. A green build doesn't prove runtime behaviour.",
  ].filter(Boolean) as string[];
  lines.push("### Suggested order", "", ...steps.map((step, i) => `${i + 1}. ${step}`), "");

  const guides = Array.from({ length: to - from }, (_, i) => from + i + 1).map((major) => `https://nextjs.org/docs/app/guides/upgrading/version-${major}`);
  lines.push(
    `Official guides: ${guides.join(", ")}. This check covers the changes a text scan can find. ` +
      "Behaviour changes, such as caching defaults and client router cache, need testing.",
  );
  if (!nodeRange) lines.push("", `(Couldn't read Node.js requirements for next@${target.version}.)`);
  return lines.join("\n");
}
