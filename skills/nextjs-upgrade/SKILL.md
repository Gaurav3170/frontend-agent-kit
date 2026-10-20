---
name: nextjs-upgrade
description: Upgrade a Next.js app to a newer major version one step at a time, using the official codemods, a pre-flight scan of the code for breaking changes, and the app's own checks as proof. Use when asked to upgrade Next.js, move to Next.js 15 or 16, or fix problems blocking a Next.js upgrade.
argument-hint: "[target major, e.g. 16]"
---

# Upgrade Next.js

Target major version: `$ARGUMENTS` (default: the latest release).

A major Next.js upgrade fails in predictable places: an old Node.js version, a library that rejects the new React, synchronous APIs that became async, and config that was renamed or removed. You'll find all of them before changing anything, then upgrade **one major version at a time** and prove each step.

Rules for the whole job:

- **Facts come from tools and official docs, not memory.** Next.js changes quickly. Use `check_nextjs_upgrade` and the upgrade guides it links. If you're not sure how an API behaves in the target version, read the guide instead of guessing.
- **One major at a time.** For 14 → 16, finish and verify 15 first.
- **Don't switch on new features as part of the upgrade.** Leave the React Compiler, Cache Components and Partial Prerendering alone unless the user asks: each changes behaviour and deserves its own change.
- **Never add `--legacy-peer-deps` or `--force`** to get an install through. A peer conflict is a real incompatibility.
- **Report honestly.** Show failing output. A green build alone doesn't close the upgrade.

## Phase 1: Pre-flight (read-only)

1. Run `git status`. The working tree should be clean. If it isn't, ask the user how to proceed.
2. Run the project's existing checks before changing anything: type check, lint, tests, production build. Record which pass. You can't tell what the upgrade broke if it was already broken.
3. Call `check_nextjs_upgrade` with `projectDir` (absolute path) and `targetMajor`. It reports:
   - **Requirements:** Node.js, React and TypeScript versions. A 🔴 Node.js row must be fixed first, locally, in CI and in the deploy image (Dockerfile, hosting settings).
   - **Dependencies that reject the new React:** each must be upgraded in the same step, often a major of its own (e.g. `@react-three/fiber` 8 → 9 for React 19). Read their migration notes too.
   - **Breaking changes found in the code**, with `file:line` locations and the codemod for each.
4. Call `audit_dependencies` too, if the user is also upgrading for security reasons. It shows which target version also fixes the advisories, and that may be a later minor than the first one you'd pick.

## Phase 2: Plan, then STOP

Present:

1. **Blockers** to fix first (Node.js version, CI image).
2. **Steps**, one per major version. For each: the `upgrade` codemod command, the extra codemods for findings in this code, the dependency upgrades, and the manual changes (each finding with its locations).
3. **What to test by hand**, from the findings that change behaviour rather than syntax, for example caching defaults, scroll behaviour and image defaults.

**Wait for approval.**

## Phase 3: Upgrade, one major at a time

For each major version:

1. Create a branch if you're not on one (e.g. `chore/nextjs-<major>`).
2. Run `npx @next/codemod@latest upgrade <major>`. It updates `next`, `react`, `react-dom` and their types, and applies that version's codemods. It runs non-interactively when an agent runs it. Read its output: it lists what it changed and what it couldn't.
3. Run the extra codemods from the plan that it didn't apply, for example `next-async-request-api`.
4. Upgrade the dependencies that rejected the new React, to the versions from the report.
5. Fix the manual findings. Then search the code for `@next-codemod-error` comments and `UnsafeUnwrapped` casts left by the codemods. Resolve every one. Don't just delete the comment.
6. Install, then run the checks in this order: type check, lint, tests, production build. Show each command and the end of its output.
7. Start the production server (`npm run build && npm run start`) and load the main routes: home, a dynamic route, anything using cookies, headers or middleware. Check the server log for warnings.
8. Call `check_nextjs_upgrade` again. Findings for this major should be gone. If the next major is still to come, its findings will remain.
9. If something fails and the fix isn't clear from the official guide, stop and report it with the error. Don't paper over it.

If the user has `perf-budget-guard`, `run_lighthouse` or `analyze_bundle` available, measure the main routes before and after each major and include the numbers. An upgrade can change bundle size in either direction.

## Phase 4: Hand it to a human

1. Show `git diff --stat` and a summary per major version: what the codemods did, what you changed by hand, and the check results.
2. **Ask before committing or pushing.** One commit per major version makes review and rollback easier.
3. A pull request description should include the versions before and after, every manual change with its reason, the checks run, the behaviour changes a reviewer should test, and anything deferred (for example "kept Webpack for now with `--webpack`").

Never merge it yourself.
