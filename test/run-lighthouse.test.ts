import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { elementsOf, runLighthouseTool } from "../src/tools/run-lighthouse.js";
import type { LighthouseRunner } from "../src/lib/lighthouse.js";
import { deps, lhr } from "./helpers.js";

const result = lhr({
  categories: {
    performance: { id: "performance", title: "Performance", score: 0.68, auditRefs: [{ id: "render-blocking-resources", weight: 0 }, { id: "largest-contentful-paint", weight: 25 }] },
    accessibility: { id: "accessibility", title: "Accessibility", score: 0.87, auditRefs: [{ id: "color-contrast", weight: 7 }, { id: "image-alt", weight: 10 }, { id: "list", weight: 0 }] },
  } as never,
  audits: {
    "largest-contentful-paint": { id: "largest-contentful-paint", title: "Largest Contentful Paint", score: 0.4, numericValue: 4200, displayValue: "4.2 s", scoreDisplayMode: "numeric" },
    "first-contentful-paint": { id: "first-contentful-paint", title: "First Contentful Paint", score: 0.9, numericValue: 1500, scoreDisplayMode: "numeric" },
    "total-blocking-time": { id: "total-blocking-time", title: "Total Blocking Time", score: 0.3, numericValue: 1500, scoreDisplayMode: "numeric" },
    "cumulative-layout-shift": { id: "cumulative-layout-shift", title: "CLS", score: 1, numericValue: 0.02, scoreDisplayMode: "numeric" },
    "render-blocking-resources": {
      id: "render-blocking-resources",
      title: "Eliminate render-blocking resources",
      score: 0.5,
      scoreDisplayMode: "metricSavings",
      metricSavings: { FCP: 450, LCP: 450 },
      details: { type: "opportunity", overallSavingsBytes: 0, items: [{ url: "http://localhost:3000/styles.css", wastedBytes: 0 }] },
    },
    "largest-contentful-paint-element": {
      id: "largest-contentful-paint-element",
      title: "LCP element",
      score: null,
      scoreDisplayMode: "informative",
      details: { type: "list", items: [{ type: "table", items: [{ node: { type: "node", selector: "main > img.hero", snippet: '<img class="hero" src="/hero.jpg">' } }] }] },
    },
    "color-contrast": {
      id: "color-contrast",
      title: "Background and foreground colors do not have a sufficient contrast ratio.",
      score: 0,
      scoreDisplayMode: "binary",
      details: {
        type: "table",
        items: [
          { node: { type: "node", selector: "footer > p", snippet: '<p class="muted">© 2026</p>', explanation: "Fix any of the following:\n  Element has insufficient color contrast of 3.1 (expected 4.5:1)" } },
        ],
      },
    },
    "image-alt": { id: "image-alt", title: "Image elements have [alt] attributes", score: 1, scoreDisplayMode: "binary" },
    list: { id: "list", title: "Lists", score: null, scoreDisplayMode: "notApplicable" },
  } as never,
});

describe("run_lighthouse", () => {
  it("reports scores, rated metrics and failing audits with their elements", async () => {
    let options: Parameters<LighthouseRunner>[0] | undefined;
    const lighthouse: LighthouseRunner = async (o) => ((options = o), result);
    const text = await runLighthouseTool.run({ url: "http://localhost:3000/" }, deps({ lighthouse }));
    assert.deepEqual(options, { url: "http://localhost:3000/", formFactor: "mobile", categories: ["performance", "accessibility"] });
    assert.match(text, /\| Performance \| 🟡 68 \|/);
    assert.match(text, /\| Largest Contentful Paint \| 4\.2 s \| 🔴 poor \|/);
    assert.match(text, /\| Cumulative Layout Shift \| 0\.020 \| 🟢 good \|/);
    assert.match(text, /LCP element: `<img class="hero" src="\/hero\.jpg">` \(selector `main > img\.hero`\)/);
    assert.match(text, /\*\*Eliminate render-blocking resources\*\*\. Est\. savings: 450 ms\./);
    assert.match(text, /### Accessibility: 1 failing audit/);
    assert.match(text, /`footer > p`.*insufficient color contrast of 3\.1/);
    assert.doesNotMatch(text, /Image elements have \[alt\]/, "passing audits aren't listed");
    assert.match(text, /Deque measured 57%/);
  });

  it("explains a refused connection", async () => {
    const lighthouse: LighthouseRunner = async () => {
      throw new Error("net::ERR_CONNECTION_REFUSED");
    };
    await assert.rejects(runLighthouseTool.run({ url: "http://localhost:3999/" }, deps({ lighthouse })), /Is the server running\?/);
  });

  it("refuses non-http URLs", async () => {
    await assert.rejects(runLighthouseTool.run({ url: "file:///etc/passwd" }, deps()), /Only http and https/);
  });
});

describe("run_lighthouse on a real Lighthouse 12.8.2 result", () => {
  // A mobile run against a production Next.js 14 build, trimmed to the audits the report reads.
  const real = JSON.parse(readFileSync(new URL("./fixtures/blog-lhr.json", import.meta.url), "utf8"));
  const run = () => runLighthouseTool.run({ url: "http://localhost:4300/blog" }, deps({ lighthouse: async () => real }));

  it("finds the LCP element inside the nested list details", async () => {
    assert.match(await run(), /LCP element: `<p class="Blog_postCardDescription__22tRw">`/);
  });

  it("keeps the insight and drops the older audit that reports the same thing", async () => {
    const text = await run();
    assert.match(text, /`render-blocking-insight`/);
    assert.doesNotMatch(text, /`render-blocking-resources`/);
    assert.match(text, /`legacy-javascript-insight`/);
    assert.doesNotMatch(text, /`legacy-javascript`(?!-)/);
  });

  it("doesn't repeat metrics as failing audits, and marks unscored accessibility rules", async () => {
    const text = await run();
    assert.doesNotMatch(text, /`first-contentful-paint`/);
    assert.match(text, /Elements with visible text labels do not have matching accessible names\*\*\. Not counted in the score\./);
  });
});

describe("elementsOf", () => {
  it("handles missing or unusual details", () => {
    assert.deepEqual(elementsOf(undefined), []);
    assert.deepEqual(elementsOf({ type: "table", items: [{ label: "nothing to show" }] }), []);
  });
});
