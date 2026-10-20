---
name: fix-vulnerable-dependencies
description: Fix npm security advisories in a JavaScript project with the smallest safe upgrades. Plans from real audit data, stops for approval, applies one change at a time, and proves each with the project's own build and tests. Use when asked to fix npm audit or Dependabot alerts, vulnerable dependencies, or security advisories.
argument-hint: "[minimum severity: low | moderate | high | critical]"
---

# Fix vulnerable dependencies

Minimum severity to fix: `$ARGUMENTS` (default `low`, so everything).

You'll fix security advisories with the **smallest change that removes each one**, and prove every change. Work in four phases. **Stop for the user's approval after Phase 2, and again before committing in Phase 4.**

Rules for the whole job:

- **Never guess a version.** Every version you propose comes from the `audit_dependencies` report or the registry, not from memory.
- **Never** run `npm audit fix --force`, delete the lockfile, or add `--legacy-peer-deps`. These hide breakage instead of fixing it.
- **Report honestly.** If a command fails, show its output and stop. Don't describe a failed step as passed.
- **Don't touch unrelated files.** If the working tree already has changes, tell the user before starting.

## Phase 1: Gather the facts (read-only)

1. Find the project root (the folder with `package.json`) and note the package manager from the lockfile: `package-lock.json` npm, `pnpm-lock.yaml` pnpm, `yarn.lock` Yarn, `bun.lock` Bun.
2. Call the `audit_dependencies` tool with `projectDir` set to the absolute project path, and `minSeverity` from the argument. If the tool isn't available, run `npm audit --json` and work from that instead, saying so.
3. Read the scripts in `package.json` to find the checks this project uses: type check, lint, tests, build. Note any that are missing. You'll run all of them later.
4. Check the Node.js version the project expects (`engines`, `.nvmrc`, `.node-version`, CI config, Dockerfile) against `node -v`. Some fixes need a newer Node.js; flag it now.
5. For every **major** upgrade in the report, find where the package is imported (search the source, not `node_modules`) and skim its changelog or release notes for breaking changes that touch those uses.

## Phase 2: Plan, then STOP

Present one table, smallest changes first:

| Package | Severity | Now | Change | Kind | Risk and what to test |
| --- | --- | --- | --- | --- | --- |

Kinds, from the report:

- **Lockfile refresh**: no `package.json` change. Lowest risk.
- **Same-major upgrade**: low risk. Still run every check.
- **Upgrade a direct dependency**: a nested package is pinned; the report names the direct dependency to move and the version.
- **Major upgrade**: name the breaking changes that affect this code, from your Phase 1 reading.
- **Override**: last resort. Say plainly that the parent package was never tested with the forced version.
- **No fix available**: recommend one of: replace the package, confirm the vulnerable code path isn't reachable (explain how you checked), or accept the risk with a written reason. The user decides.

Use the report's "Smallest set of package.json changes" table. When two advisories need the same package, one upgrade to the higher version fixes both.

Group the plan into separate steps if it mixes majors with small fixes, so small fixes can merge even if a major upgrade needs more work. Then **stop and wait for approval.** Don't edit anything yet.

## Phase 3: Apply and prove each change

For each approved step, in order:

1. Make the change: edit `package.json` to the exact version from the plan, or run the refresh command (`npm update <pkg>`, or the pnpm/Yarn/Bun equivalent).
2. Install with the project's package manager (`npm install`). If the install fails on a peer dependency conflict, stop and report the conflict. Don't force it.
3. Run every check from Phase 1, in this order: type check, lint, tests, production build. Paste the command and the last lines of its output for each.
4. Call `audit_dependencies` again and confirm the advisory is gone and nothing new appeared.
5. If anything fails, **revert that step** (`git checkout -- package.json <lockfile>` and reinstall), explain why it failed, and move on to the next step or stop, whichever the user prefers.

If the project has a start command, start the production build and load one or two main routes after the final step. A green build doesn't prove the app runs.

## Phase 4: Hand it to a human

1. Run `git status` and `git diff --stat`. Only your intended files should have changed: `package.json`, the lockfile, and code a major upgrade required.
2. Show the user a summary and **ask before committing or pushing.**
3. If they agree, commit on a new branch (not the default branch), e.g. `fix/dependency-advisories`, with a message listing the packages. If they want a pull request, its description should contain:
   - a before/after table: package, old version, new version, advisories fixed (with links);
   - anything not fixed, and why;
   - the exact checks you ran and their results;
   - what a reviewer should test by hand, for each major upgrade.

Never merge it yourself.
