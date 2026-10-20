import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkNextjsUpgrade, pickTarget } from "../src/tools/check-nextjs-upgrade.js";
import { deps, fakeRegistry, project } from "./helpers.js";

const REACT_PEER = "^18.2.0 || 19.0.0-rc-de68d2f4-20241204 || ^19.0.0";

const registry = () =>
  fakeRegistry({
    next: {
      versions: [
        { version: "14.2.35", engines: { node: ">=18.17.0" }, peerDependencies: { react: "^18.2.0" } },
        { version: "15.5.28", engines: { node: "^18.18.0 || ^19.8.0 || >= 20.0.0" }, peerDependencies: { react: REACT_PEER } },
        { version: "16.0.0-canary.1" },
        { version: "16.4.2", engines: { node: ">=20.9.0" }, peerDependencies: { react: REACT_PEER } },
      ],
      latest: "16.4.2",
    },
    react: { versions: ["18.3.1", "19.0.0", "19.3.1"] },
    "@react-three/fiber": {
      versions: [
        { version: "8.18.0", peerDependencies: { react: ">=18 <19" } },
        { version: "9.0.0", peerDependencies: { react: "^19.0.0" } },
      ],
    },
  });

/** A small Next.js 14 App Router app with one of each pattern the scan looks for. */
function next14App(extra: Record<string, string | object> = {}) {
  return project({
    "package.json": {
      scripts: { build: "next build", lint: "next lint" },
      dependencies: { next: "14.2.35", react: "18.3.1", "@react-three/fiber": "8.18.0", "plain-lib": "1.0.0" },
      devDependencies: { typescript: "5.9.3" },
    },
    "node_modules/next/package.json": { name: "next", version: "14.2.35" },
    "node_modules/@react-three/fiber/package.json": { name: "@react-three/fiber", version: "8.18.0", peerDependencies: { react: ">=18 <19" } },
    "node_modules/plain-lib/package.json": { name: "plain-lib", version: "1.0.0" },
    ".eslintrc.json": {},
    "src/app/blog/[slug]/page.tsx": "export default function Page({ params }: { params: { slug: string } }) {\n  return params.slug;\n}\n",
    "src/app/api/items/route.ts": "export async function GET() {\n  return Response.json([]);\n}\n",
    "src/lib/session.ts": 'import { cookies } from "next/headers";\nexport const token = () => cookies().get("token");\n',
    "src/styles/globals.scss": "html {\n  scroll-behavior: smooth;\n}\n",
    "next.config.mjs": "export default { webpack: (config) => config, images: { domains: ['cdn.example.com'] } };\n",
    ...extra,
  });
}

describe("check_nextjs_upgrade", () => {
  it("checks requirements: Node.js, React and peer ranges", async () => {
    const text = await checkNextjsUpgrade.run({ projectDir: next14App() }, deps({ registry: registry(), nodeVersion: "18.17.1" }));
    assert.match(text, /## Next\.js upgrade check: 14\.2\.35 → 16\.4\.2/);
    assert.match(text, /\| Node\.js \| 18\.17\.1 \| >=20\.9\.0 \| 🔴/);
    assert.match(text, /\| React \| 18\.3\.1 \| 19\.3\.1 \| 🟡/);
    assert.match(text, /\| `@react-three\/fiber` \| 8\.18\.0 \| `>=18 <19` \| upgrade to 9\.0\.0 \(major\) \|/);
    assert.doesNotMatch(text, /plain-lib/, "packages without a react peer aren't conflicts");
  });

  it("finds Next.js 15 and 16 breaking changes with locations", async () => {
    const text = await checkNextjsUpgrade.run({ projectDir: next14App() }, deps({ registry: registry() }));
    assert.match(text, /Synchronous params \/ searchParams[\s\S]*`src\/app\/blog\/\[slug\]\/page\.tsx:1`/);
    assert.match(text, /Synchronous cookies\(\)[\s\S]*`src\/lib\/session\.ts:2`/);
    assert.match(text, /no longer cached by default[\s\S]*`src\/app\/api\/items\/route\.ts:1`/);
    assert.match(text, /next lint removed[\s\S]*package\.json scripts\.lint[\s\S]*\.eslintrc\.json/);
    assert.match(text, /Custom webpack config[\s\S]*`next\.config\.mjs:1`/);
    assert.match(text, /images\.domains deprecated/);
    assert.match(text, /scroll-behavior[\s\S]*`src\/styles\/globals\.scss:2`/);
  });

  it("says to go one major at a time and links each guide", async () => {
    const text = await checkNextjsUpgrade.run({ projectDir: next14App() }, deps({ registry: registry() }));
    assert.match(text, /one major at a time: 15, then 16\. Run `npx @next\/codemod@latest upgrade 15`/);
    assert.match(text, /version-15, https:\/\/nextjs\.org\/docs\/app\/guides\/upgrading\/version-16/);
  });

  it("only reports changes between the two versions", async () => {
    const text = await checkNextjsUpgrade.run({ projectDir: next14App(), targetMajor: 15 }, deps({ registry: registry() }));
    assert.match(text, /14\.2\.35 → 15\.5\.28/);
    assert.match(text, /Synchronous params/);
    assert.doesNotMatch(text, /next lint removed|scroll-behavior/);
  });

  it("doesn't flag code that is already migrated", async () => {
    const dir = next14App({
      "src/app/blog/[slug]/page.tsx": "export default async function Page(props: { params: Promise<{ slug: string }> }) {\n  const { slug } = await props.params;\n  return slug;\n}\n",
      "src/lib/session.ts": 'import { cookies } from "next/headers";\nexport const token = async () => (await cookies()).get("token");\n',
      "src/app/api/items/route.ts": 'export const dynamic = "force-static";\nexport async function GET() {\n  return Response.json([]);\n}\n',
    });
    const text = await checkNextjsUpgrade.run({ projectDir: dir }, deps({ registry: registry() }));
    assert.doesNotMatch(text, /Synchronous params|Synchronous cookies|no longer cached/);
  });

  it("flags parallel route slots without default.js", async () => {
    const dir = next14App({ "src/app/@modal/login/page.tsx": "export default () => null;", "src/app/@sidebar/default.tsx": "export default () => null;" });
    const text = await checkNextjsUpgrade.run({ projectDir: dir }, deps({ registry: registry() }));
    assert.match(text, /Parallel route slots need default\.js \(Next\.js 16\)\n\n[^\n]+\n\n- `src\/app\/@modal`\n\n/);
  });

  it("works when react isn't declared", async () => {
    const dir = project({ "package.json": { dependencies: { next: "14.2.35" } }, "node_modules/next/package.json": { version: "14.2.35" } });
    const text = await checkNextjsUpgrade.run({ projectDir: dir }, deps({ registry: registry() }));
    assert.match(text, /\| React \| not declared \| 19\.3\.1 \| 🟡/);
  });

  it("stops early when already on the target major", async () => {
    const dir = project({ "package.json": { dependencies: { next: "16.1.0" } }, "node_modules/next/package.json": { version: "16.1.0" } });
    const text = await checkNextjsUpgrade.run({ projectDir: dir }, deps({ registry: registry() }));
    assert.match(text, /already on major 16/);
  });

  it("rejects projects without Next.js", async () => {
    await assert.rejects(checkNextjsUpgrade.run({ projectDir: project({ "package.json": {} }) }, deps({ registry: registry() })), /no "next" dependency/);
  });
});

describe("pickTarget", () => {
  const versions = [{ version: "15.0.0" }, { version: "15.5.28" }, { version: "16.0.0-rc.1" }, { version: "16.4.2" }];
  it("uses latest by default and skips prereleases for a major", () => {
    assert.equal(pickTarget(versions, "16.4.2")?.version, "16.4.2");
    assert.equal(pickTarget(versions, "16.4.2", 15)?.version, "15.5.28");
    assert.equal(pickTarget(versions, "16.4.2", 17), undefined);
  });
});
