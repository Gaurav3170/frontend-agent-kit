import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { auditDependencies } from "../src/tools/audit-dependencies.js";
import { advisory, deps, fakeRegistry, project } from "./helpers.js";

/** package-lock.json v3 from a list of [install path, entry]. */
function lockfile(root: object, entries: Record<string, object>) {
  return { name: "app", lockfileVersion: 3, packages: { "": root, ...entries } };
}

describe("audit_dependencies", () => {
  it("reports no advisories as green", async () => {
    const dir = project({
      "package.json": { dependencies: { a: "1.0.0" } },
      "package-lock.json": lockfile({ dependencies: { a: "1.0.0" } }, { "node_modules/a": { version: "1.0.0" } }),
    });
    const text = await auditDependencies.run({ projectDir: dir }, deps({ registry: fakeRegistry({ a: { versions: ["1.0.0"] } }) }));
    assert.match(text, /Checked 1 installed package/);
    assert.match(text, /No known advisories/);
  });

  it("prefers a same-major upgrade for a direct dependency", async () => {
    const dir = project({
      "package.json": { dependencies: { yaml: "2.8.1" } },
      "package-lock.json": lockfile({ dependencies: { yaml: "2.8.1" } }, { "node_modules/yaml": { version: "2.8.1" } }),
    });
    const registry = fakeRegistry({ yaml: { versions: ["2.8.1", "2.8.2", "2.8.3", "3.0.0"], advisories: [advisory(1, "moderate", ">=2.0.0 <2.8.3")] } });
    const text = await auditDependencies.run({ projectDir: dir }, deps({ registry }));
    assert.match(text, /\| `yaml` \| 🟡 moderate \| 2\.8\.1 \| direct \| Same-major upgrade \| 2\.8\.3 \|/);
    assert.match(text, /Change: `"yaml": "2\.8\.3" in package\.json`/);
  });

  it("never suggests a version that another advisory affects", async () => {
    // 2.0.0 fixes advisory 1 but is hit by advisory 2, which doesn't affect the installed 1.0.0.
    const dir = project({
      "package.json": { dependencies: { lib: "1.0.0" } },
      "package-lock.json": lockfile({ dependencies: { lib: "1.0.0" } }, { "node_modules/lib": { version: "1.0.0" } }),
    });
    const registry = fakeRegistry({
      lib: { versions: ["1.0.0", "2.0.0", "2.0.1"], advisories: [advisory(1, "high", "<2.0.0"), advisory(2, "critical", ">=2.0.0 <2.0.1")] },
    });
    const text = await auditDependencies.run({ projectDir: dir }, deps({ registry }));
    assert.match(text, /Major upgrade \| 2\.0\.1 \|/);
    assert.match(text, /\| `lib` \| 🟠 high/, "severity counts only advisories that affect what's installed");
  });

  it("refreshes the lockfile when the parent's range already allows a fix", async () => {
    const dir = project({
      "package.json": { dependencies: { parent: "1.0.0" } },
      "package-lock.json": lockfile(
        { dependencies: { parent: "1.0.0" } },
        { "node_modules/parent": { version: "1.0.0", dependencies: { child: "^1.0.0" } }, "node_modules/child": { version: "1.0.0" } },
      ),
    });
    const registry = fakeRegistry({ parent: { versions: ["1.0.0"] }, child: { versions: ["1.0.0", "1.0.1"], advisories: [advisory(1, "high", "<1.0.1")] } });
    const text = await auditDependencies.run({ projectDir: dir }, deps({ registry }));
    assert.match(text, /\| `child` .* \| via parent \| Lockfile refresh \| 1\.0\.1 \|/);
    assert.match(text, /Change: `npm update child`/);
  });

  it("finds the direct dependency to upgrade when a nested package pins the vulnerable version", async () => {
    // The real shape from a Next.js 14 app: eslint-config-next → @next/eslint-plugin-next → glob.
    const dir = project({
      "package.json": { devDependencies: { "eslint-config-next": "14.2.35" } },
      "package-lock.json": lockfile(
        { devDependencies: { "eslint-config-next": "14.2.35" } },
        {
          "node_modules/eslint-config-next": { version: "14.2.35", dev: true, dependencies: { "@next/eslint-plugin-next": "14.2.35" } },
          "node_modules/@next/eslint-plugin-next": { version: "14.2.35", dev: true, dependencies: { glob: "10.3.10" } },
          "node_modules/glob": { version: "10.3.10", dev: true },
        },
      ),
    });
    const registry = fakeRegistry({
      "eslint-config-next": {
        versions: [
          { version: "14.2.35", dependencies: { "@next/eslint-plugin-next": "14.2.35" } },
          { version: "15.0.0", dependencies: { "@next/eslint-plugin-next": "15.0.0" } },
          { version: "16.0.0", dependencies: { "@next/eslint-plugin-next": "16.0.0" } },
        ],
      },
      "@next/eslint-plugin-next": {
        versions: [
          { version: "14.2.35", dependencies: { glob: "10.3.10" } },
          { version: "15.0.0", dependencies: { "fast-glob": "3.3.1" } },
          { version: "16.0.0", dependencies: { "fast-glob": "3.3.1" } },
        ],
      },
      glob: { versions: ["10.3.10", "10.5.0"], advisories: [advisory(1, "high", ">=10.2.0 <10.5.0", "glob CLI command injection")] },
    });
    const text = await auditDependencies.run({ projectDir: dir }, deps({ registry }));
    assert.match(text, /### 🟠 glob \(dev only\)/);
    assert.match(text, /Upgrade eslint-config-next 14\.2\.35 → 15\.0\.0 \(major\)/);
    assert.match(text, /pulled in by: eslint-config-next → @next\/eslint-plugin-next → glob/);
    assert.match(text, /\| `eslint-config-next` \| 14\.2\.35 → 15\.0\.0 \(major\) \| glob \|/);
  });

  it("merges two fixes for the same direct dependency into the higher version", async () => {
    // next 15 fixes next itself, but only next 16 stops pinning a vulnerable postcss.
    const dir = project({
      "package.json": { dependencies: { next: "14.2.35" } },
      "package-lock.json": lockfile(
        { dependencies: { next: "14.2.35" } },
        { "node_modules/next": { version: "14.2.35", dependencies: { postcss: "8.4.31" } }, "node_modules/postcss": { version: "8.4.31" } },
      ),
    });
    const registry = fakeRegistry({
      next: {
        versions: [
          { version: "14.2.35", dependencies: { postcss: "8.4.31" } },
          { version: "15.5.27", dependencies: { postcss: "8.4.31" } },
          { version: "16.3.8", dependencies: { postcss: "8.5.23" } },
        ],
        advisories: [advisory(1, "critical", "<15.5.16")],
      },
      postcss: { versions: ["8.4.31", "8.5.23"], advisories: [advisory(2, "high", "<=8.5.22")] },
    });
    const text = await auditDependencies.run({ projectDir: dir }, deps({ registry }));
    assert.match(text, /\| `next` \| 14\.2\.35 → 16\.3\.8 \(major\) \| next, postcss \|/);
  });

  it("suggests an override as a last resort when no parent release allows a fix", async () => {
    const dir = project({
      "package.json": { dependencies: { parent: "1.0.0" } },
      "package-lock.json": lockfile(
        { dependencies: { parent: "1.0.0" } },
        { "node_modules/parent": { version: "1.0.0", dependencies: { child: "1.0.0" } }, "node_modules/child": { version: "1.0.0" } },
      ),
    });
    const registry = fakeRegistry({
      parent: { versions: [{ version: "1.0.0", dependencies: { child: "1.0.0" } }, { version: "1.1.0", dependencies: { child: "1.0.0" } }] },
      child: { versions: ["1.0.0", "1.0.1"], advisories: [advisory(1, "high", "<1.0.1")] },
    });
    const text = await auditDependencies.run({ projectDir: dir }, deps({ registry }));
    assert.match(text, /Override \(last resort\)/);
    assert.match(text, /No release of parent yet allows a fixed child/);
    assert.match(text, /"overrides": \{ "child": "1\.0\.1" \}/);
  });

  it("says so when no version is free of advisories", async () => {
    const dir = project({
      "package.json": { dependencies: { old: "1.0.0" } },
      "package-lock.json": lockfile({ dependencies: { old: "1.0.0" } }, { "node_modules/old": { version: "1.0.0" } }),
    });
    const registry = fakeRegistry({ old: { versions: ["1.0.0", "1.1.0"], advisories: [advisory(1, "high", "*")] } });
    const text = await auditDependencies.run({ projectDir: dir }, deps({ registry }));
    assert.match(text, /No fix available/);
  });

  it("filters by severity and can leave out dev-only packages", async () => {
    const dir = project({
      "package.json": { dependencies: { a: "1.0.0" }, devDependencies: { b: "1.0.0" } },
      "package-lock.json": lockfile(
        { dependencies: { a: "1.0.0" }, devDependencies: { b: "1.0.0" } },
        { "node_modules/a": { version: "1.0.0" }, "node_modules/b": { version: "1.0.0", dev: true } },
      ),
    });
    const registry = fakeRegistry({
      a: { versions: ["1.0.0", "1.0.1"], advisories: [advisory(1, "low", "<1.0.1")] },
      b: { versions: ["1.0.0", "1.0.1"], advisories: [advisory(2, "critical", "<1.0.1")] },
    });
    const highOnly = await auditDependencies.run({ projectDir: dir, minSeverity: "high" }, deps({ registry }));
    assert.match(highOnly, /`b`/);
    assert.doesNotMatch(highOnly, /\| `a` \|/);
    const prodOnly = await auditDependencies.run({ projectDir: dir, includeDev: false }, deps({ registry }));
    assert.match(prodOnly, /\| `a` \|/);
    assert.doesNotMatch(prodOnly, /\| `b` \|/);
  });

  it("reads node_modules when there is no package-lock.json", async () => {
    const dir = project({
      "package.json": { dependencies: { "@scope/a": "1.0.0" } },
      "yarn.lock": "",
      "node_modules/@scope/a/package.json": { name: "@scope/a", version: "1.0.0" },
    });
    const registry = fakeRegistry({ "@scope/a": { versions: ["1.0.0", "1.0.1"], advisories: [advisory(1, "high", "<1.0.1")] } });
    const text = await auditDependencies.run({ projectDir: dir }, deps({ registry }));
    assert.match(text, /from node_modules/);
    assert.match(text, /`@scope\/a`/);
    assert.match(text, /use the yarn equivalent/);
  });

  it("asks for an install when there is nothing to read", async () => {
    const dir = project({ "package.json": { dependencies: { a: "1.0.0" } } });
    await assert.rejects(auditDependencies.run({ projectDir: dir }, deps()), /Install dependencies first/);
  });
});
