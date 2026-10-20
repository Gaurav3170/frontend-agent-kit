import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, posix } from "node:path";
import { gzipSync } from "node:zlib";
import { z } from "zod";
import { ToolError } from "../lib/errors.js";
import { capped, formatBytes, plural, table } from "../lib/format.js";
import { loadProject, readInstalledPackage, readJson } from "../lib/project.js";
import { defineTool } from "./types.js";

/** One route (or HTML page) and the JavaScript it downloads before it can run. */
export interface RouteBundle {
  route: string;
  /** Paths relative to the build directory, e.g. "static/chunks/972-163e9d664298da67.js". */
  files: string[];
}

export interface BundleLayout {
  kind: string;
  /** Absolute build directory; route file paths are relative to it. */
  buildDir: string;
  routes: RouteBundle[];
  /** Directory (relative to buildDir) holding every emitted chunk, for finding lazy-loaded ones. */
  chunkDir?: string;
  /** Chunks in chunkDir that no route lists but that aren't on-demand code either (framework runtime, polyfills). */
  notLazy?: string[];
}

interface FileSize {
  raw: number;
  gzip: number;
}

const DEFAULT_TOP = 10;

export const analyzeBundle = defineTool({
  name: "analyze_bundle",
  title: "Analyze bundle",
  description:
    "Reads a project's production build output and reports how much JavaScript each route downloads on first load " +
    "(raw and gzip), the chunks every route shares, the largest chunks and which routes load them, and lazy-loaded chunks. " +
    "Supports Next.js (App and Pages Router, versions 13 to 16) and static builds with HTML entry points such as Vite or " +
    "Create React App. Read-only: it does not build. Run the project's production build first, and run it again after a change to compare.",
  network: false,
  inputSchema: {
    projectDir: z.string().optional().describe("Absolute path of the project root. Defaults to the server's working directory."),
    budgetKb: z
      .number()
      .positive()
      .optional()
      .describe("Optional first-load JavaScript budget per route, in gzip kB. Routes over it are flagged."),
    top: z.number().int().min(1).max(50).optional().describe(`How many of the largest chunks to list (default ${DEFAULT_TOP}).`),
  },
  async run({ projectDir, budgetKb, top = DEFAULT_TOP }) {
    const project = await loadProject(projectDir);
    const layout = await detectLayout(project.dir);
    return report(layout, await measure(layout), { budgetBytes: budgetKb ? budgetKb * 1000 : undefined, top });
  },
});

/** Finds the build output and works out which files each route loads first. */
export async function detectLayout(dir: string): Promise<BundleLayout> {
  const nextDir = join(dir, ".next");
  if (existsSync(join(nextDir, "build-manifest.json"))) return nextLayout(dir, nextDir);
  if (existsSync(nextDir)) {
    throw new ToolError(
      `${nextDir} exists but has no build-manifest.json, so it holds a dev build. Run the production build (e.g. "npm run build") and call this tool again.`,
    );
  }
  for (const name of ["dist", "build", "out"]) {
    const buildDir = join(dir, name);
    if (existsSync(join(buildDir, "index.html"))) return htmlLayout(buildDir);
  }
  throw new ToolError(
    `No production build found in ${dir} (looked for .next/, and dist/, build/ or out/ with an index.html). Run the production build first.`,
  );
}

async function nextLayout(dir: string, buildDir: string): Promise<BundleLayout> {
  const version = (await readInstalledPackage(dir, "next"))?.version ?? "unknown version";
  const buildManifest = (await readJson<BuildManifest>(join(buildDir, "build-manifest.json")))!;
  const routes = [...(await appRouterRoutes(buildDir, buildManifest)), ...pagesRouterRoutes(buildManifest)];
  const routers = [routes.some((r) => !r.route.startsWith("pages:")) && "App Router", routes.some((r) => r.route.startsWith("pages:")) && "Pages Router"]
    .filter(Boolean)
    .join(" + ");
  // Runtime files that aren't on-demand code: the Pages Router runtime (only loaded by
  // Pages Router routes, which list it) and the polyfills only old browsers download.
  const runtime = [
    ...(buildManifest.polyfillFiles ?? []),
    ...Object.values(buildManifest.pages).flat(),
  ];
  return {
    kind: `Next.js ${version}${routers ? `, ${routers}` : ""}`,
    buildDir,
    routes: routes.map((r) => ({ ...r, route: r.route.replace(/^pages:/, "") })),
    chunkDir: "static/chunks",
    notLazy: runtime,
  };
}

interface BuildManifest {
  rootMainFiles?: string[];
  polyfillFiles?: string[];
  pages: Record<string, string[]>;
}

const PAGES_INTERNALS = new Set(["/_app", "/_document", "/_error"]);

function pagesRouterRoutes(manifest: BuildManifest): RouteBundle[] {
  const shared = manifest.pages["/_app"] ?? [];
  return Object.keys(manifest.pages)
    .filter((page) => !PAGES_INTERNALS.has(page))
    .sort()
    .map((page) => ({ route: `pages:${page}`, files: jsOnly([...(manifest.pages[page] ?? []), ...shared]) }));
}

/**
 * App Router routes. Next.js 13 to 15 list each segment's files (layouts and the page) in
 * app-build-manifest.json, so a route loads the union of its page and every layout above
 * it. Next.js 16 dropped that file and records the same union per page as `entryJSFiles`
 * in the page's client reference manifest.
 */
async function appRouterRoutes(buildDir: string, buildManifest: BuildManifest): Promise<RouteBundle[]> {
  const appPaths = await readJson<Record<string, string>>(join(buildDir, "server", "app-paths-manifest.json"));
  if (!appPaths) return [];
  const pagePaths = Object.keys(appPaths).filter((path) => path.endsWith("/page")).sort();
  const segments = (await readJson<{ pages: Record<string, string[]> }>(join(buildDir, "app-build-manifest.json")))?.pages;

  const routes: RouteBundle[] = [];
  for (const pagePath of pagePaths) {
    let files: string[] | undefined;
    if (segments) {
      files = segmentChain(pagePath).flatMap((segment) => segments[segment] ?? []);
    } else {
      const entry = await readClientReferenceEntry(buildDir, pagePath);
      if (entry) files = [...Object.values(entry).flat(), ...(buildManifest.rootMainFiles ?? [])];
    }
    if (files) routes.push({ route: appRoute(pagePath), files: jsOnly(files) });
  }
  return routes;
}

/** "/shop/[id]/page" → ["/layout", "/shop/layout", "/shop/[id]/layout", "/shop/[id]/page"]. */
export function segmentChain(pagePath: string): string[] {
  const parts = pagePath.split("/").filter(Boolean).slice(0, -1);
  const layouts = parts.map((_, i) => `/${parts.slice(0, i + 1).join("/")}/layout`);
  return ["/layout", ...layouts, pagePath];
}

/** "/(shop)/products/[id]/page" → "/products/[id]": route groups and parallel slots aren't in the URL. */
export function appRoute(pagePath: string): string {
  const parts = pagePath
    .split("/")
    .filter((part) => part && part !== "page" && !/^\(.*\)$/.test(part) && !part.startsWith("@"));
  return `/${parts.join("/")}`;
}

/** The manifest is a script that assigns `globalThis.__RSC_MANIFEST[pagePath]`. */
async function readClientReferenceEntry(buildDir: string, pagePath: string): Promise<Record<string, string[]> | undefined> {
  const file = join(buildDir, "server", "app", `${pagePath}_client-reference-manifest.js`);
  if (!existsSync(file)) return undefined;
  const scope = globalThis as { __RSC_MANIFEST?: Record<string, { entryJSFiles?: Record<string, string[]> }> };
  const previous = scope.__RSC_MANIFEST;
  scope.__RSC_MANIFEST = {};
  try {
    const require = createRequire(import.meta.url);
    delete require.cache[file];
    require(file);
    return scope.__RSC_MANIFEST?.[pagePath]?.entryJSFiles;
  } catch {
    return undefined;
  } finally {
    scope.__RSC_MANIFEST = previous;
  }
}

/** Static builds: each HTML file loads its <script src> and <link rel="modulepreload"> files. */
async function htmlLayout(buildDir: string): Promise<BundleLayout> {
  const htmlFiles = (await listFiles(buildDir)).filter((file) => file.endsWith(".html")).slice(0, 200);
  const routes: RouteBundle[] = [];
  for (const file of htmlFiles) {
    const html = await readFile(join(buildDir, file), "utf8");
    const files = scriptReferences(html, posix.dirname(file)).filter((ref) => existsSync(join(buildDir, ref)));
    routes.push({ route: `/${file}`.replace(/\/index\.html$/, "/") || "/", files: unique(files) });
  }
  return { kind: "Static build (HTML entry points)", buildDir, routes, chunkDir: "" };
}

const SCRIPT_SRC = /<script\b[^>]*\bsrc=["']([^"']+)["']/gi;
const MODULE_PRELOAD = /<link\b(?=[^>]*\brel=["']modulepreload["'])[^>]*\bhref=["']([^"']+)["']/gi;

/** Same-origin script paths referenced by an HTML file, relative to the build directory. */
export function scriptReferences(html: string, htmlDir: string): string[] {
  const refs = [...html.matchAll(SCRIPT_SRC), ...html.matchAll(MODULE_PRELOAD)].map((match) => match[1]!);
  return refs
    .filter((ref) => !/^(https?:)?\/\//i.test(ref) && !ref.startsWith("data:"))
    .map((ref) => {
      const path = ref.split(/[?#]/)[0]!;
      return path.startsWith("/") ? path.slice(1) : posix.normalize(posix.join(htmlDir, path));
    });
}

export interface Measured {
  sizes: Map<string, FileSize>;
  /** Chunks that exist in the build but no route loads up front (dynamic imports). */
  lazy: string[];
}

export async function measure(layout: BundleLayout): Promise<Measured> {
  const sizes = new Map<string, FileSize>();
  const sizeOf = async (file: string) => {
    if (sizes.has(file)) return;
    const content = await readFile(join(layout.buildDir, file)).catch(() => null);
    // A gzip at the default level is close to what a typical server sends; Brotli is a little smaller.
    if (content) sizes.set(file, { raw: content.length, gzip: gzipSync(content).length });
  };
  for (const route of layout.routes) for (const file of route.files) await sizeOf(file);

  const lazy: string[] = [];
  if (layout.chunkDir !== undefined) {
    const loaded = new Set([...layout.routes.flatMap((route) => route.files), ...(layout.notLazy ?? [])]);
    const chunkRoot = join(layout.buildDir, layout.chunkDir);
    for (const file of await listFiles(chunkRoot)) {
      const path = layout.chunkDir ? `${layout.chunkDir}/${file}` : file;
      if (!path.endsWith(".js") || loaded.has(path)) continue;
      await sizeOf(path);
      lazy.push(path);
    }
  }
  return { sizes, lazy };
}

interface ReportOptions {
  budgetBytes?: number;
  top: number;
}

export function report(layout: BundleLayout, { sizes, lazy }: Measured, { budgetBytes, top }: ReportOptions): string {
  if (layout.routes.length === 0) {
    throw new ToolError(`Found a ${layout.kind} build in ${layout.buildDir}, but no routes in it. Is the build complete?`);
  }
  const total = (files: string[]) =>
    files.reduce((sum, file) => ({ raw: sum.raw + (sizes.get(file)?.raw ?? 0), gzip: sum.gzip + (sizes.get(file)?.gzip ?? 0) }), { raw: 0, gzip: 0 });

  const routes = layout.routes
    .map((route) => ({ ...route, size: total(route.files) }))
    .sort((a, b) => b.size.gzip - a.size.gzip);
  const shared = layout.routes.length > 1 ? layout.routes.map((r) => r.files).reduce((a, b) => a.filter((file) => b.includes(file))) : [];
  const sharedSize = total(shared);

  const lines = [`## Bundle report: ${layout.kind}`, "", `Build directory: \`${layout.buildDir}\``, ""];

  lines.push("### First-load JavaScript per route", "");
  lines.push(
    table(
      ["Route", "Gzip", "Raw", "Files", ...(budgetBytes ? ["Budget"] : [])],
      routes.map((route) => [
        `\`${route.route}\``,
        formatBytes(route.size.gzip),
        formatBytes(route.size.raw),
        String(route.files.length),
        ...(budgetBytes ? [route.size.gzip > budgetBytes ? `🔴 over by ${formatBytes(route.size.gzip - budgetBytes)}` : "🟢"] : []),
      ]),
    ),
    "",
  );
  if (shared.length) {
    lines.push(
      `Shared by every route: **${formatBytes(sharedSize.gzip)}** gzip (${formatBytes(sharedSize.raw)} raw) in ${plural(shared.length, "file")}. ` +
        "Shrinking these helps every page at once.",
      "",
    );
  }

  const usedBy = new Map<string, string[]>();
  for (const route of layout.routes) for (const file of route.files) usedBy.set(file, [...(usedBy.get(file) ?? []), route.route]);
  const chunks = [...usedBy.keys()].filter((file) => sizes.has(file)).sort((a, b) => sizes.get(b)!.gzip - sizes.get(a)!.gzip);
  lines.push(`### Largest first-load chunks`, "");
  lines.push(
    table(
      ["Chunk", "Gzip", "Raw", "Loaded by"],
      chunks.slice(0, top).map((file) => {
        const routesUsing = usedBy.get(file)!;
        const by = routesUsing.length === layout.routes.length ? "every route" : routesUsing.map((r) => `\`${r}\``).join(", ");
        return [`\`${file}\``, formatBytes(sizes.get(file)!.gzip), formatBytes(sizes.get(file)!.raw), by];
      }),
    ),
    "",
  );

  if (lazy.length) {
    const lazySorted = lazy.filter((file) => sizes.has(file)).sort((a, b) => sizes.get(b)!.gzip - sizes.get(a)!.gzip);
    const lazyTotal = total(lazySorted);
    lines.push(
      `### Lazy-loaded chunks`,
      "",
      `${plural(lazySorted.length, "chunk")} (${formatBytes(lazyTotal.gzip)} gzip) are not loaded up front. They load on demand, ` +
        "for example through `import()` or `next/dynamic`. Largest:",
      "",
      ...capped(lazySorted, Math.min(top, 5), (file) => `- \`${file}\`: ${formatBytes(sizes.get(file)!.gzip)} gzip`),
      "",
    );
  }

  const over = budgetBytes ? routes.filter((route) => route.size.gzip > budgetBytes) : [];
  if (budgetBytes) {
    lines.push(
      over.length
        ? `**${plural(over.length, "route")} over the ${formatBytes(budgetBytes)} budget.**`
        : `All routes are within the ${formatBytes(budgetBytes)} budget.`,
      "",
    );
  }
  lines.push(
    "Notes: gzip sizes are an estimate of what's sent over the network (Brotli is usually a little smaller). " +
      "Chunk names change between builds, so compare routes, not chunk names. To see which modules fill a large chunk, " +
      "use the bundler's analyzer (for Next.js, `@next/bundle-analyzer`). CSS, fonts and images are not included.",
  );
  return lines.join("\n");
}

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(root, path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function jsOnly(files: string[]): string[] {
  return unique(files.filter((file) => file.endsWith(".js")));
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
