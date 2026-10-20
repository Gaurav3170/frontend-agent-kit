import type { Result } from "lighthouse";
import { z } from "zod";
import { ToolError } from "../lib/errors.js";
import { capped, formatBytes, formatMs, table } from "../lib/format.js";
import type { Category } from "../lib/lighthouse.js";
import { defineTool } from "./types.js";

const CATEGORY_IDS = ["performance", "accessibility", "best-practices", "seo"] as const;
const MAX_FAILED_AUDITS = 15;
const MAX_ELEMENTS = 5;

const METRICS = [
  { id: "largest-contentful-paint", label: "Largest Contentful Paint", good: 2500, poor: 4000 },
  { id: "first-contentful-paint", label: "First Contentful Paint", good: 1800, poor: 3000 },
  { id: "total-blocking-time", label: "Total Blocking Time", good: 200, poor: 600 },
  { id: "cumulative-layout-shift", label: "Cumulative Layout Shift", good: 0.1, poor: 0.25 },
  { id: "speed-index", label: "Speed Index", good: 3400, poor: 5800 },
] as const;

/** Older audits and the Lighthouse 12 insight that reports the same finding; the insight is kept. */
const INSIGHT_FOR: Record<string, string> = {
  "render-blocking-resources": "render-blocking-insight",
  "legacy-javascript": "legacy-javascript-insight",
  "uses-optimized-images": "image-delivery-insight",
  "modern-image-formats": "image-delivery-insight",
  "uses-responsive-images": "image-delivery-insight",
  "efficient-animated-content": "image-delivery-insight",
  "font-display": "font-display-insight",
  "uses-long-cache-ttl": "cache-insight",
  "layout-shifts": "cls-culprits-insight",
  "unsized-images": "cls-culprits-insight",
  "third-party-summary": "third-parties-insight",
  "dom-size": "dom-size-insight",
  "duplicated-javascript": "duplicated-javascript-insight",
  "redirects": "document-latency-insight",
  "server-response-time": "document-latency-insight",
  "uses-text-compression": "document-latency-insight",
  "lcp-lazy-loaded": "lcp-discovery-insight",
  "prioritize-lcp-image": "lcp-discovery-insight",
  "viewport": "viewport-insight",
};

export const runLighthouseTool = defineTool({
  name: "run_lighthouse",
  title: "Run Lighthouse",
  description:
    "Runs a Lighthouse audit on a URL in headless Chrome and returns the category scores, lab metrics (LCP, FCP, TBT, CLS, " +
    "Speed Index) and every failing audit with its estimated savings and the elements it found. The accessibility category " +
    "runs axe-core and lists the failing elements with their selectors. Use it on a local production server " +
    "(e.g. http://localhost:3000 after a production build and start) so results reflect what users get. " +
    "Lab data from one run: results vary by a few points between runs, so re-run before acting on a small difference. Takes 15 to 60 s.",
  network: true,
  inputSchema: {
    url: z.string().url().describe("Page to audit, e.g. http://localhost:3000/products."),
    formFactor: z.enum(["mobile", "desktop"]).optional().describe('Simulated device (default "mobile": a mid-range phone on a slow 4G connection).'),
    categories: z
      .array(z.enum(CATEGORY_IDS))
      .min(1)
      .optional()
      .describe('Categories to run (default ["performance", "accessibility"]).'),
  },
  async run({ url, formFactor = "mobile", categories = ["performance", "accessibility"] }, { lighthouse }) {
    const protocol = new URL(url).protocol;
    if (protocol !== "http:" && protocol !== "https:") throw new ToolError(`Only http and https URLs can be audited, got ${protocol}`);
    let lhr: Result;
    try {
      lhr = await lighthouse({ url, formFactor, categories: categories as Category[] });
    } catch (error) {
      const message = (error as Error).message;
      const hint = /ECONNREFUSED|ERR_CONNECTION_REFUSED|FAILED_DOCUMENT_REQUEST/.test(message)
        ? " Nothing answered at that URL. Is the server running?"
        : "";
      throw new ToolError(`Lighthouse failed on ${url}: ${message}.${hint}`);
    }
    return report(lhr, formFactor);
  },
});

export function report(lhr: Result, formFactor: string): string {
  const lines = [`## Lighthouse: ${lhr.finalDisplayedUrl || lhr.requestedUrl}`, ""];
  lines.push(`${formFactor === "desktop" ? "Desktop" : "Mobile (simulated mid-range phone, slow 4G)"} · Lighthouse ${lhr.lighthouseVersion} · one run`, "");

  const categories = Object.values(lhr.categories);
  lines.push(table(["Category", "Score"], categories.map((c) => [c.title, scoreText(c.score)])), "");

  if (lhr.categories["performance"]) {
    lines.push("### Lab metrics", "");
    lines.push(
      table(
        ["Metric", "Value", "Rating"],
        METRICS.filter((m) => lhr.audits[m.id]?.numericValue !== undefined).map((m) => {
          const value = lhr.audits[m.id]!.numericValue!;
          const rating = value <= m.good ? "🟢 good" : value <= m.poor ? "🟡 needs improvement" : "🔴 poor";
          return [m.label, m.id === "cumulative-layout-shift" ? value.toFixed(3) : formatMs(value), rating];
        }),
      ),
      "",
    );
    const lcpElement = elementsOf(lhr.audits["largest-contentful-paint-element"]?.details)[0];
    if (lcpElement) lines.push(`LCP element: ${lcpElement}`, "");
    lines.push(
      "Interaction to Next Paint (INP) needs real user input, so Lighthouse can't measure it. Total Blocking Time is the closest lab signal.",
      "",
    );
  }

  // Already shown in the metrics table and LCP line.
  const metricIds = new Set<string>([...METRICS.map((m) => m.id), "interactive", "max-potential-fid", "largest-contentful-paint-element"]);
  for (const category of categories) {
    const refs = category.auditRefs.filter((ref) => !metricIds.has(ref.id));
    const ids = new Set(refs.map((ref) => ref.id));
    const failing = refs
      .map((ref) => ({ ref, audit: lhr.audits[ref.id] }))
      .filter(({ audit }) => audit && audit.score !== null && audit.score < 0.9 && !["informative", "notApplicable", "manual"].includes(audit.scoreDisplayMode))
      // Lighthouse 12 reports some findings twice, as an "insight" and as the older audit.
      .filter(({ ref }) => !ids.has(`${INSIGHT_FOR[ref.id] ?? ""}`))
      .sort((a, b) => b.ref.weight - a.ref.weight || savingsMs(b.audit!) - savingsMs(a.audit!) || (a.audit!.score ?? 0) - (b.audit!.score ?? 0));
    if (!failing.length) continue;
    lines.push(`### ${category.title}: ${failing.length} failing audit${failing.length === 1 ? "" : "s"}`, "");
    for (const { ref, audit } of failing.slice(0, MAX_FAILED_AUDITS)) {
      const savings = savingsText(audit!);
      // Weight 0 in a scored category means Lighthouse reports it without counting it (often an experimental rule).
      const unscored = ref.weight === 0 && category.id !== "performance" ? " Not counted in the score." : "";
      const title = audit!.title.replace(/\.$/, "");
      lines.push(`- **${title}**${audit!.displayValue ? ` (${audit!.displayValue})` : ""}.${savings ? ` Est. savings: ${savings}.` : ""}${unscored} \`${audit!.id}\``);
      for (const element of capped(elementsOf(audit!.details), MAX_ELEMENTS, (e) => e)) lines.push(`  - ${element}`);
    }
    if (failing.length > MAX_FAILED_AUDITS) lines.push(`- …and ${failing.length - MAX_FAILED_AUDITS} more`);
    lines.push("");
  }

  if (lhr.runWarnings?.length) lines.push("### Warnings", "", ...lhr.runWarnings.map((w) => `- ${w}`), "");
  if (lhr.categories["accessibility"]) {
    lines.push(
      "Automated checks find a little over half of real accessibility issues (Deque measured 57% across nearly 300,000 audited issues). " +
        "A passing score doesn't mean the page is accessible: keyboard navigation, focus order and screen-reader wording still need a manual check.",
    );
  }
  return lines.join("\n");
}

function scoreText(score: number | null): string {
  if (score === null) return "—";
  const value = Math.round(score * 100);
  return `${value >= 90 ? "🟢" : value >= 50 ? "🟡" : "🔴"} ${value}`;
}

type Audit = Result["audits"][string];

/**
 * Load-time savings. TBT savings are left out: Lighthouse gives every main-thread audit
 * the same TBT estimate, so it doesn't say which audit to fix first.
 */
function savingsMs(audit: Audit): number {
  const savings = audit.metricSavings as Record<string, number | undefined> | undefined;
  return Math.max(savings?.["LCP"] ?? 0, savings?.["FCP"] ?? 0);
}

function savingsText(audit: Audit): string {
  const parts: string[] = [];
  const ms = savingsMs(audit);
  if (ms >= 50) parts.push(formatMs(ms));
  const bytes = (audit.details as { overallSavingsBytes?: number } | undefined)?.overallSavingsBytes;
  if (bytes && bytes >= 1000) parts.push(formatBytes(bytes));
  return parts.join(", ");
}

interface DetailsItem {
  node?: { type?: string; selector?: string; snippet?: string; nodeLabel?: string; explanation?: string };
  url?: string;
  wastedBytes?: number;
  totalBytes?: number;
  [key: string]: unknown;
}

/** One line per failing element or resource, so the agent can find it in the code. */
export function elementsOf(details: unknown): string[] {
  const items = (details as { items?: DetailsItem[] } | undefined)?.items;
  if (!Array.isArray(items)) return [];
  const lines: string[] = [];
  for (const item of items) {
    // "list" details (e.g. largest-contentful-paint-element) hold tables of their own.
    if (item["type"] === "table" && Array.isArray(item["items"])) {
      lines.push(...elementsOf(item));
      continue;
    }
    const node = item.node?.type === "node" ? item.node : (Object.values(item).find((v) => (v as DetailsItem["node"])?.type === "node") as DetailsItem["node"]);
    if (node?.selector || node?.snippet) {
      const fix = node.explanation ? `. ${firstLine(node.explanation)}` : "";
      lines.push(`\`${truncate(node.snippet ?? node.selector!, 140)}\` (selector \`${node.selector ?? "?"}\`)${fix}`);
    } else if (typeof item.url === "string" && item.url) {
      const wasted = typeof item.wastedBytes === "number" && item.wastedBytes >= 1000 ? `: ${formatBytes(item.wastedBytes)} could be saved` : "";
      lines.push(`${truncate(item.url, 140)}${wasted}`);
    }
  }
  return lines;
}

/** axe explanations start with "Fix any of the following:"; keep the first actionable line. */
function firstLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length > 1 && /^Fix (any|all) of the following:?$/.test(lines[0]!) ? `${lines[0]} ${lines[1]}` : lines[0]!;
}

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ");
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}
