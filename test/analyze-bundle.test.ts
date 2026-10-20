import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyzeBundle, appRoute, scriptReferences, segmentChain } from "../src/tools/analyze-bundle.js";
import { deps, incompressible, project } from "./helpers.js";

const js = incompressible;

/** A Next.js 14-style App Router build: per-segment files in app-build-manifest.json. */
function next14Build() {
  return project({
    "package.json": { name: "shop", dependencies: { next: "14.2.35" } },
    "node_modules/next/package.json": { name: "next", version: "14.2.35" },
    ".next/build-manifest.json": {
      polyfillFiles: ["static/chunks/polyfills.js"],
      rootMainFiles: ["static/chunks/main-app.js"],
      pages: { "/_app": ["static/chunks/framework.js"] },
    },
    ".next/server/app-paths-manifest.json": { "/page": "app/page.js", "/products/[id]/page": "app/products/[id]/page.js", "/api/route": "app/api/route.js" },
    ".next/app-build-manifest.json": {
      pages: {
        "/layout": ["static/chunks/main-app.js", "static/chunks/layout.js", "static/css/app.css"],
        "/page": ["static/chunks/main-app.js", "static/chunks/home.js"],
        "/products/layout": ["static/chunks/main-app.js", "static/chunks/products-layout.js"],
        "/products/[id]/page": ["static/chunks/main-app.js", "static/chunks/three.js", "static/chunks/product.js"],
      },
    },
    ".next/static/chunks/main-app.js": js(40_000),
    ".next/static/chunks/layout.js": js(2_000),
    ".next/static/chunks/home.js": js(3_000),
    ".next/static/chunks/products-layout.js": js(1_000),
    ".next/static/chunks/three.js": js(170_000),
    ".next/static/chunks/product.js": js(5_000),
    ".next/static/chunks/lazy-map.js": js(60_000),
    ".next/static/chunks/polyfills.js": js(30_000),
    ".next/static/chunks/framework.js": js(45_000),
  });
}

describe("analyze_bundle", () => {
  it("adds every layout above an App Router page to its first load", async () => {
    const text = await analyzeBundle.run({ projectDir: next14Build() }, deps());
    assert.match(text, /Next\.js 14\.2\.35, App Router/);
    assert.match(text, /\| `\/products\/\[id\]` \| [\d.]+ [kB]+ \| 218 kB \| 5 \|/);
    assert.match(text, /\| `\/` \| [\d.]+ [kB]+ \| 45\.0 kB \| 3 \|/);
    assert.doesNotMatch(text, /`\/api`/, "route handlers load no JavaScript");
  });

  it("names the routes that load each chunk", async () => {
    const text = await analyzeBundle.run({ projectDir: next14Build() }, deps());
    assert.match(text, /`static\/chunks\/three\.js` \| .* \| `\/products\/\[id\]` \|/);
    assert.match(text, /`static\/chunks\/main-app\.js` \| .* \| every route \|/);
  });

  it("lists on-demand chunks, but not the polyfills or the Pages Router runtime", async () => {
    const text = await analyzeBundle.run({ projectDir: next14Build() }, deps());
    assert.match(text, /1 chunk .* not loaded up front/);
    assert.match(text, /lazy-map\.js/);
    assert.doesNotMatch(text, /polyfills\.js/);
    assert.doesNotMatch(text, /framework\.js/);
  });

  it("flags routes over the budget", async () => {
    const text = await analyzeBundle.run({ projectDir: next14Build(), budgetKb: 50 }, deps());
    assert.match(text, /`\/products\/\[id\]` .* 🔴 over by/);
    assert.match(text, /\*\*1 route over the 50\.0 kB budget\.\*\*/);
    assert.match(text, /`\/` \| .* 🟢/);
  });

  it("reads Next.js 16 builds from client reference manifests", async () => {
    const dir = project({
      "package.json": { dependencies: { next: "16.4.2" } },
      "node_modules/next/package.json": { name: "next", version: "16.4.2" },
      ".next/build-manifest.json": { rootMainFiles: ["static/chunks/root.js"], pages: {} },
      ".next/server/app-paths-manifest.json": { "/(shop)/cart/page": "app/(shop)/cart/page.js" },
      ".next/server/app/(shop)/cart/page_client-reference-manifest.js":
        'globalThis.__RSC_MANIFEST=(globalThis.__RSC_MANIFEST||{});globalThis.__RSC_MANIFEST["/(shop)/cart/page"]={"entryJSFiles":{"[project]/app/layout":["static/chunks/layout.js"],"[project]/app/(shop)/cart/page":["static/chunks/cart.js","static/css/cart.css"]}};',
      ".next/static/chunks/root.js": js(10_000),
      ".next/static/chunks/layout.js": js(1_000),
      ".next/static/chunks/cart.js": js(4_000),
    });
    const text = await analyzeBundle.run({ projectDir: dir }, deps());
    assert.match(text, /Next\.js 16\.4\.2, App Router/);
    assert.match(text, /\| `\/cart` \| .* \| 15\.0 kB \| 3 \|/);
  });

  it("reads Pages Router routes with the shared _app files", async () => {
    const dir = project({
      "package.json": { dependencies: { next: "13.5.0" } },
      ".next/build-manifest.json": {
        pages: { "/_app": ["static/chunks/framework.js", "static/chunks/app.js"], "/": ["static/chunks/index.js"], "/_error": ["static/chunks/error.js"] },
      },
      ".next/static/chunks/framework.js": js(40_000),
      ".next/static/chunks/app.js": js(2_000),
      ".next/static/chunks/index.js": js(3_000),
      ".next/static/chunks/error.js": js(1_000),
    });
    const text = await analyzeBundle.run({ projectDir: dir }, deps());
    assert.match(text, /Pages Router/);
    assert.match(text, /\| `\/` \| .* \| 45\.0 kB \| 3 \|/);
    assert.doesNotMatch(text, /_error/);
  });

  it("reads static builds from their HTML entry points", async () => {
    const dir = project({
      "package.json": { name: "vite-app" },
      "dist/index.html": '<script type="module" src="/assets/index-Bx9.js"></script><link rel="modulepreload" href="/assets/vendor-Ab1.js"><script src="https://cdn.example.com/a.js"></script>',
      "dist/about/index.html": '<script type="module" src="../assets/index-Bx9.js"></script>',
      "dist/assets/index-Bx9.js": js(20_000),
      "dist/assets/vendor-Ab1.js": js(50_000),
      "dist/assets/chart-Cc2.js": js(80_000),
    });
    const text = await analyzeBundle.run({ projectDir: dir }, deps());
    assert.match(text, /Static build/);
    assert.match(text, /\| `\/` \| .* \| 70\.0 kB \| 2 \|/);
    assert.match(text, /\| `\/about\/` \| .* \| 20\.0 kB \| 1 \|/);
    assert.match(text, /chart-Cc2\.js/, "unreferenced chunks are lazy");
  });

  it("asks for a production build when .next only holds a dev build", async () => {
    const dir = project({ "package.json": {}, ".next/trace": "" });
    await assert.rejects(analyzeBundle.run({ projectDir: dir }, deps()), /dev build.*npm run build/);
  });

  it("asks for a build when there is no output", async () => {
    await assert.rejects(analyzeBundle.run({ projectDir: project({ "package.json": {} }) }, deps()), /No production build found/);
  });
});

describe("route helpers", () => {
  it("builds the layout chain for a page", () => {
    assert.deepEqual(segmentChain("/shop/[id]/page"), ["/layout", "/shop/layout", "/shop/[id]/layout", "/shop/[id]/page"]);
    assert.deepEqual(segmentChain("/page"), ["/layout", "/page"]);
  });

  it("drops route groups and parallel slots from the URL", () => {
    assert.equal(appRoute("/(shop)/products/[id]/page"), "/products/[id]");
    assert.equal(appRoute("/@modal/login/page"), "/login");
    assert.equal(appRoute("/page"), "/");
  });

  it("resolves relative and absolute script references, skipping other origins", () => {
    const html = '<script src="./a.js?v=1"></script><script src="/b.js"></script><script src="//cdn.x/c.js"></script><script src="data:text/javascript,1"></script>';
    assert.deepEqual(scriptReferences(html, "docs"), ["docs/a.js", "b.js"]);
  });
});
