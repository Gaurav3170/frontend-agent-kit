import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dependents, fromLockfile, nameFromPath, resolveDependency, shortestChain } from "../src/lib/inventory.js";

// Two copies of "c": a hoisted 2.0.0, and 1.0.0 nested under "b" because b needs ^1.
const packages = fromLockfile({
  "": { name: "app", dependencies: { a: "^1.0.0" }, devDependencies: { b: "^1.0.0" } },
  "node_modules/a": { version: "1.0.0", dependencies: { c: "^2.0.0" } },
  "node_modules/b": { version: "1.0.0", dev: true, dependencies: { c: "^1.0.0", "@s/d": "1.0.0" } },
  "node_modules/b/node_modules/c": { version: "1.0.0", dev: true },
  "node_modules/c": { version: "2.0.0" },
  "node_modules/@s/d": { version: "1.0.0", dev: true },
  "node_modules/linked": { link: true },
});

describe("inventory", () => {
  it("reads names from install paths, including scoped and nested ones", () => {
    assert.equal(nameFromPath("node_modules/b/node_modules/c"), "c");
    assert.equal(nameFromPath("node_modules/@s/d"), "@s/d");
    assert.equal(packages.get("")!.dependencies["b"], "^1.0.0", "the root's devDependencies are installed too");
    assert.equal(packages.has("node_modules/linked"), false, "workspace links aren't packages");
  });

  it("resolves the way Node does: nearest node_modules first, then up", () => {
    assert.equal(resolveDependency(packages, "node_modules/b", "c"), "node_modules/b/node_modules/c");
    assert.equal(resolveDependency(packages, "node_modules/a", "c"), "node_modules/c");
    assert.equal(resolveDependency(packages, "node_modules/b", "@s/d"), "node_modules/@s/d");
    assert.equal(resolveDependency(packages, "", "missing"), undefined);
  });

  it("finds who depends on each copy and the shortest chain to it", () => {
    const parents = dependents(packages);
    assert.deepEqual(parents.get("node_modules/b/node_modules/c"), [{ from: "node_modules/b", range: "^1.0.0" }]);
    assert.deepEqual(shortestChain("node_modules/b/node_modules/c", parents), ["node_modules/b", "node_modules/b/node_modules/c"]);
    assert.deepEqual(shortestChain("node_modules/a", parents), ["node_modules/a"]);
  });
});
