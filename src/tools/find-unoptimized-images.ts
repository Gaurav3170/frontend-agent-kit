import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { capped, formatBytes, plural, table } from "../lib/format.js";
import { displayPath, lineAt, walk } from "../lib/files.js";
import { readImageInfo, type ImageInfo } from "../lib/image-size.js";
import { declaredRange, loadProject } from "../lib/project.js";
import { defineTool } from "./types.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg"]);
// .ts can't hold JSX. .js can (older React projects), so it's scanned, with strings and regexes skipped.
const MARKUP_EXTENSIONS = new Set([".jsx", ".tsx", ".js", ".html", ".vue", ".svelte", ".astro", ".mdx"]);
const MAX_ROWS = 25;

/** Wider than any layout slot on a 2x screen; past this the extra pixels are rarely shown. */
const DEFAULT_MAX_WIDTH = 2560;
const DEFAULT_MAX_KB = 200;

export const findUnoptimizedImages = defineTool({
  name: "find_unoptimized_images",
  title: "Find unoptimized images",
  description:
    "Scans a project's source and static files for image problems that slow pages down or shift the layout: " +
    "image files that are too heavy or too wide, PNG/JPEG/GIF files that a modern format (AVIF or WebP) would shrink, " +
    "large SVGs, and <img> tags in JSX/TSX, HTML, Vue, Svelte, Astro or MDX that are missing width/height (layout shift), " +
    "lazy loading, or alt text, or that could use the framework's image component (next/image). " +
    "Read-only. Static analysis only, so check flagged tags whose attributes come from spread props.",
  network: false,
  inputSchema: {
    projectDir: z.string().optional().describe("Absolute path of the project root. Defaults to the server's working directory."),
    maxKb: z.number().positive().optional().describe(`Flag image files larger than this, in kB (default ${DEFAULT_MAX_KB}).`),
    maxWidth: z.number().int().positive().optional().describe(`Flag raster images wider than this, in pixels (default ${DEFAULT_MAX_WIDTH}).`),
  },
  async run({ projectDir, maxKb = DEFAULT_MAX_KB, maxWidth = DEFAULT_MAX_WIDTH }) {
    const project = await loadProject(projectDir);
    const usesNext = declaredRange(project.packageJson, "next") !== undefined;
    const imageScan = await walk(project.dir, IMAGE_EXTENSIONS);
    const images = await checkImages(project.dir, imageScan.files, { maxBytes: maxKb * 1000, maxWidth });
    const markupScan = await walk(project.dir, MARKUP_EXTENSIONS);
    const tags: TagIssue[] = [];
    for (const file of markupScan.files) {
      const text = await readFile(file, "utf8").catch(() => "");
      if (text.includes("<img")) tags.push(...checkImgTags(text, displayPath(project.dir, file), { usesNext }));
    }
    return report({
      images,
      imageCount: imageScan.files.length,
      tags,
      fileCount: markupScan.files.length,
      truncated: imageScan.truncated || markupScan.truncated,
      maxKb,
      maxWidth,
    });
  },
});

export interface ImageIssue {
  path: string;
  bytes: number;
  info: ImageInfo | null;
  problems: string[];
}

export async function checkImages(root: string, files: string[], limits: { maxBytes: number; maxWidth: number }): Promise<ImageIssue[]> {
  const issues: ImageIssue[] = [];
  for (const file of files) {
    const bytes = (await stat(file)).size;
    const info = await readImageInfo(file).catch(() => null);
    const problems = imageProblems(bytes, info, limits);
    if (problems.length) issues.push({ path: displayPath(root, file), bytes, info, problems });
  }
  return issues.sort((a, b) => b.bytes - a.bytes);
}

export function imageProblems(bytes: number, info: ImageInfo | null, { maxBytes, maxWidth }: { maxBytes: number; maxWidth: number }): string[] {
  const problems: string[] = [];
  if (info?.format === "svg") {
    // Large SVGs are usually embedded bitmaps or unminified exports.
    if (bytes > 50_000) problems.push("large SVG: minify it (e.g. SVGO) or check for an embedded bitmap");
    return problems;
  }
  if (bytes > maxBytes) problems.push(`over ${formatBytes(maxBytes)}`);
  if (info?.width && info.width > maxWidth) problems.push(`${info.width}px wide (limit ${maxWidth}px): resize it`);
  // Small icons gain little from re-encoding; only suggest it where the saving is worth a change.
  // Google's WebP study: lossless 26% smaller than PNG, lossy 25–34% smaller than JPEG.
  if (bytes > 50_000 && (info?.format === "png" || info?.format === "jpeg")) problems.push("WebP is about 25–34% smaller (AVIF often more)");
  if (info?.format === "gif" && bytes > 100_000) problems.push("animated GIF: a muted looping <video> (MP4/WebM) is usually far smaller");
  return problems;
}

export interface TagIssue {
  path: string;
  line: number;
  snippet: string;
  problems: string[];
}

const IMG_TAG = /<img\b([^>]*?)\/?>/gis;

/**
 * Flags <img> tags by their attributes. A tag with a spread ({...props}) may get the
 * attribute at runtime, so only the problems that a spread can't explain are reported.
 */
export function checkImgTags(text: string, path: string, { usesNext }: { usesNext: boolean }): TagIssue[] {
  const issues: TagIssue[] = [];
  const isJsx = /\.(jsx|tsx|js|ts|mdx)$/.test(path);
  for (const match of text.matchAll(IMG_TAG)) {
    const attrs = match[1] ?? "";
    // `<img` in a code sample, or inside a string or regex in a script, isn't markup.
    if (isInCodeFence(text, match.index!) || (isJsx && isInStringOrRegex(text, match.index!))) continue;
    const has = (name: string) => new RegExp(`(^|\\s|:)${name}\\s*=`, "i").test(attrs);
    const spread = /\{\s*\.\.\./.test(attrs) || /v-bind\s*=|\$\$restProps/.test(attrs);
    const problems: string[] = [];
    if (!spread) {
      if (!has("width") || !has("height")) problems.push("no width/height: the layout shifts when it loads (CLS)");
      if (!has("alt")) problems.push('no alt: add a description, or alt="" if it is decorative');
      if (!has("loading") && !/fetchpriority\s*=/i.test(attrs)) {
        problems.push('no loading attribute: add loading="lazy" below the fold, or fetchpriority="high" on the LCP image');
      }
    }
    if (usesNext && isJsx) problems.push("next/image would add responsive sizes, modern formats and lazy loading");
    if (problems.length) {
      issues.push({ path, line: lineAt(text, match.index!), snippet: match[0].replace(/\s+/g, " ").slice(0, 120), problems });
    }
  }
  return issues;
}

/**
 * True when `<img` sits right after a quote, backtick or slash on its own line, the way
 * it appears in a string or regex, not where JSX puts a tag (after `(`, `>`, `return`, `{`, `&&`, `?` or `:`).
 */
function isInStringOrRegex(text: string, offset: number): boolean {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const before = text.slice(lineStart, offset).trimEnd();
  return /["'`/]$/.test(before) || /\b(includes|indexOf|startsWith|match|test|replace)\($/.test(before);
}

/** True when the offset is inside a ``` fenced block (MDX and markdown code samples). */
function isInCodeFence(text: string, offset: number): boolean {
  const before = text.slice(0, offset).match(/^```/gm);
  return (before?.length ?? 0) % 2 === 1;
}

interface ReportInput {
  images: ImageIssue[];
  imageCount: number;
  tags: TagIssue[];
  fileCount: number;
  truncated: boolean;
  maxKb: number;
  maxWidth: number;
}

export function report({ images, imageCount, tags, fileCount, truncated, maxKb, maxWidth }: ReportInput): string {
  const lines = ["## Image audit", ""];
  lines.push(
    `Scanned ${plural(imageCount, "image file")} and ${plural(fileCount, "source file")} (skipping node_modules and build output). ` +
      `Limits: ${maxKb} kB per file, ${maxWidth}px wide.`,
    "",
  );
  if (truncated) lines.push("⚠️ Stopped after 20,000 files. Pass a sub-directory as projectDir to scan the rest.", "");
  if (!images.length && !tags.length) {
    lines.push("No problems found. 🟢");
    return lines.join("\n");
  }

  if (images.length) {
    const total = images.reduce((sum, image) => sum + image.bytes, 0);
    lines.push(`### Image files (${images.length}, ${formatBytes(total)} in total)`, "");
    lines.push(
      table(
        ["File", "Size", "Dimensions", "Problems"],
        images.slice(0, MAX_ROWS).map((image) => [
          `\`${image.path}\``,
          formatBytes(image.bytes),
          image.info?.width ? `${image.info.width}×${image.info.height}` : (image.info?.format ?? "?"),
          image.problems.join("; "),
        ]),
      ),
      "",
    );
    if (images.length > MAX_ROWS) lines.push(`…and ${images.length - MAX_ROWS} more.`, "");
  }

  if (tags.length) {
    lines.push(`### <img> tags (${tags.length})`, "");
    const byProblem = new Map<string, number>();
    for (const tag of tags) for (const problem of tag.problems) byProblem.set(problem, (byProblem.get(problem) ?? 0) + 1);
    lines.push(...[...byProblem].sort((a, b) => b[1] - a[1]).map(([problem, count]) => `- ${count}× ${problem}`), "");
    lines.push(...capped(tags, MAX_ROWS, (tag) => `- \`${tag.path}:${tag.line}\` \`${tag.snippet}\`: ${tag.problems.join("; ")}`), "");
  }

  lines.push(
    "File sizes are on disk. If a CDN or image component resizes and re-encodes images on request, " +
      "a large source file may still reach users at a reasonable size. Check the page's network panel or run_lighthouse before re-encoding.",
  );
  return lines.join("\n");
}
