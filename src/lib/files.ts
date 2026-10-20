import { readdir } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";

/** Dependencies, build output and tool caches: never the code a person wrote. */
export const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".turbo",
  ".vercel",
  ".cache",
  "dist",
  "build",
  "out",
  "coverage",
  "storybook-static",
]);

/** Stops a scan of a huge monorepo from running for minutes; the result says when it was hit. */
export const MAX_FILES = 20_000;

export interface WalkResult {
  files: string[];
  truncated: boolean;
}

/** Files under `root` with one of `extensions` (lower-case, with the dot), skipping ignored directories. */
export async function walk(root: string, extensions: ReadonlySet<string>, ignored = IGNORED_DIRS): Promise<WalkResult> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // Unreadable directory (permissions, broken link): skip it.
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) pending.push(join(dir, entry.name));
      } else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) {
        files.push(join(dir, entry.name));
        if (files.length >= MAX_FILES) return { files: files.sort(), truncated: true };
      }
    }
  }
  return { files: files.sort(), truncated: false };
}

/** Project-relative path with forward slashes, so output reads the same on every OS. */
export function displayPath(root: string, file: string): string {
  return relative(root, file).split(sep).join("/");
}

/** 1-based line number of a character offset. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}
