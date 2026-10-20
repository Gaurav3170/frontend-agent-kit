# Frontend Agent Kit

An MCP server and three Claude Code skills that give an AI coding agent real data about a frontend project, so its answers come from measurements instead of guesses:

- **5 tools** (MCP): `analyze_bundle`, `audit_dependencies`, `run_lighthouse`, `find_unoptimized_images` and `check_nextjs_upgrade`. Each one reads the project and returns a markdown report. None of them edit files or install anything.
- **3 skills** (Claude Code): `fix-vulnerable-dependencies`, `nextjs-upgrade` and `accessibility-audit`. Each is a written playbook the agent follows from start to finish: gather facts with the tools, propose the smallest change, **stop for approval**, apply it, prove it with the project's own checks, and hand a pull request to a person.

The tools work with any MCP client (Claude Code, Cursor, VS Code, Windsurf and others). The skills are for Claude Code.

## In plain words

Ask an AI assistant "which page on my site loads the most JavaScript?" or "how do I fix these security alerts?" and it will often answer from memory. It might guess a version that's still vulnerable, or a package size from a blog post. These tools let it look instead:

| Ask | Tool | What it reads |
| --- | --- | --- |
| Which pages load the most JavaScript, and why? | `analyze_bundle` | Your production build output |
| What's vulnerable, and what's the smallest safe fix? | `audit_dependencies` | Your lockfile and the npm advisory database |
| How fast and accessible is this page? | `run_lighthouse` | The page, loaded in headless Chrome |
| Which images are too heavy or shift the layout? | `find_unoptimized_images` | Your image files and `<img>` tags |
| What will break if I upgrade Next.js? | `check_nextjs_upgrade` | Your code, `package.json` and the npm registry |

The skills then chain these into a complete job, like "fix every security advisory", in the order an experienced engineer would do it, with a person approving each change.

## Example: what it found on a real site

These are real reports from running the tools on [my portfolio](https://github.com/Gaurav3170/portfolio-2026), a Next.js 14 site, in October 2026.

**`audit_dependencies`** found the same four vulnerable packages as `npm audit`, then worked out the smallest set of upgrades that fixes all of them:

| Package | Change | Fixes |
| --- | --- | --- |
| `next` | 14.2.35 → 16.3.8 (major) | next, postcss |
| `eslint-config-next` | 14.2.35 → 15.0.0 (major) | glob |
| `yaml` | 2.8.1 → 2.8.3 | yaml |

`npm audit` suggests the latest release of each (`next` 16.4.2, `eslint-config-next` 16.4.2, `yaml` 2.9.1). Two things in that table are easy to miss by hand:

- **Next.js 15 fixes Next.js's own advisories, but not the bundled PostCSS.** Every Next.js 15 release pins PostCSS 8.4.31, which has two high-severity advisories. The first release that ships a fixed PostCSS without an advisory of its own is 16.3.8. The tool found that by following `next`'s dependency on `postcss` through each release, so the report says "16.3.8" instead of "upgrade Next.js".
- **The `glob` advisory is fixed by a lint config major, not by `glob`.** `glob` is three levels down (`eslint-config-next` → `@next/eslint-plugin-next` → `glob`) and pinned to an exact version. `@next/eslint-plugin-next` 15 replaced it with `fast-glob`, so upgrading `eslint-config-next` removes it entirely.

Every suggested version is checked against **all** of the package's advisories, not only the ones affecting the installed version. That way a fix never trades one advisory for another.

**`check_nextjs_upgrade`** to 16.4.2 found five blockers before any code changed: Node.js 18 (16 needs 20.9 or later), `@react-three/fiber` 8 (rejects React 19; 9.0.0 accepts it), synchronous `params` in five places in the blog post page, `next lint` with a legacy `.eslintrc.json`, and a `scroll-behavior: smooth` rule whose behaviour changes in 16.

**`run_lighthouse`** on the blog index: Performance 96, Accessibility 100. The accessibility score is 100, but it still found a real issue: the logo link's `aria-label` ("Gaurav Keswani, back to start") doesn't contain its visible text. That fails WCAG 2.5.3 (Label in Name), and Lighthouse reports it but doesn't count it in the score.

## Quick start

You need Node.js 18.17 or later. Four of the five tools work straight away. `run_lighthouse` needs Lighthouse added and Chrome or Chromium installed: see [Enabling run_lighthouse](#enabling-run_lighthouse).

### Claude Code: tools and skills

```text
/plugin marketplace add Gaurav3170/frontend-agent-kit
/plugin install frontend-agent-kit@frontend-agent-kit
```

The skills then run as:

```text
/frontend-agent-kit:fix-vulnerable-dependencies high
/frontend-agent-kit:nextjs-upgrade 16
/frontend-agent-kit:accessibility-audit http://localhost:3000/checkout
```

The tools are available in every conversation too. Ask "which route loads the most JavaScript?" and Claude calls `analyze_bundle`.

### Claude Code: tools only

```sh
claude mcp add frontend-agent-kit -- npx -y frontend-agent-kit
```

### Other MCP clients

Add a stdio server that runs `npx -y frontend-agent-kit`. For most clients that's this JSON in their MCP settings file:

```json
{
  "mcpServers": {
    "frontend-agent-kit": {
      "command": "npx",
      "args": ["-y", "frontend-agent-kit"]
    }
  }
}
```

### Enabling run_lighthouse

Lighthouse and its dependencies make up about 170 MB, nine tenths of a full install. Most MCP clients give a server 30 seconds to start, and on a first run `npx` can't download that much in time, so Lighthouse is an optional dependency. Without it, the server installs in about 15 seconds.

To add it, start the server with Lighthouse as extra packages:

```sh
claude mcp add frontend-agent-kit -- npx -y -p frontend-agent-kit -p lighthouse@12.8.2 -p chrome-launcher@1.2.0 frontend-agent-kit
```

For other clients, use the same `npx` arguments in the JSON above. The first start then takes about a minute, so if the client reports a timeout, restart it once the download has finished: `npx` keeps the packages, and later starts are quick. In Claude Code you can also raise the limit for that first start with `MCP_TIMEOUT=120000 claude`.

If `frontend-agent-kit` is a dev dependency of your project instead, run `npm install -D lighthouse@12.8.2 chrome-launcher@1.2.0`.

Without Lighthouse, `run_lighthouse` returns these instructions instead of failing, and the `accessibility-audit` skill offers to continue with its code review.

### A warning you can ignore on Node.js 18

On Node.js 18, `npm` prints `EBADENGINE Unsupported engine` for `@hono/node-server`. The MCP SDK only uses that package for its HTTP transport, and this server talks over stdio, so it's never loaded. Node.js 20 or later doesn't print the warning.

### Without an agent

Every tool also runs from the command line and prints its report:

```sh
npx frontend-agent-kit analyze_bundle --project . --budget-kb 150
npx frontend-agent-kit audit_dependencies --project . --min-severity high
npx frontend-agent-kit run_lighthouse --url http://localhost:3000/ --categories performance,accessibility
npx frontend-agent-kit find_unoptimized_images --project .
npx frontend-agent-kit check_nextjs_upgrade --project . --target 16
```

## Tools

Every tool takes `projectDir`, the **absolute** path of the project root. The server's working directory isn't always the user's project.

### `analyze_bundle`

First-load JavaScript per route (gzip and raw), the chunks every route shares, the largest chunks and which routes load them, and lazy-loaded chunks. Optional `budgetKb` flags routes over a gzip budget.

- **Next.js 13 to 16, App and Pages Router.** An App Router route loads its page and every layout above it. Next.js 13 to 15 record those files in `app-build-manifest.json`. Next.js 16 removed that file and the "First Load JS" column from `next build`, so for 16 the tool reads each page's client reference manifest instead.
- **Static builds** (Vite, Create React App, Astro and others): reads `<script src>` and `<link rel="modulepreload">` from every HTML file in `dist/`, `build/` or `out/`.
- It doesn't build. Run the production build first.

### `audit_dependencies`

Reads `package-lock.json` (or `node_modules` for Yarn and Bun), asks the npm advisory database about every installed version, and plans a fix for each vulnerable package:

| Fix | When |
| --- | --- |
| Lockfile refresh | Every dependent's range already allows a safe version. No `package.json` change. |
| Same-major upgrade | A direct dependency has a safe version in its current major. |
| Upgrade a direct dependency | A nested package is pinned. The tool walks the dependency chain and finds the lowest release of the direct dependency whose tree allows a safe version, or no longer includes the package. |
| Major upgrade | Nothing smaller works. |
| Override | No release of the parent allows a fix yet. Last resort. |

Then it merges the fixes into one list of `package.json` changes, taking the higher version when two fixes need the same package. Options: `minSeverity`, `includeDev`. pnpm's symlinked store isn't supported yet; the tool says so and suggests `pnpm audit`.

### `run_lighthouse`

Needs Lighthouse added: see [Enabling run_lighthouse](#enabling-run_lighthouse). One Lighthouse 12.8.2 run in a fresh headless Chrome, on a simulated mid-range phone by default (`formFactor: "desktop"` for desktop). It reports:

- category scores;
- lab metrics with good / needs improvement / poor ratings;
- the LCP element;
- every failing audit, with estimated savings and the elements or files it found.

Accessibility checks come from axe-core and list each failing element's selector and HTML. Where Lighthouse 12 reports the same finding twice (an "insight" and an older audit), only the insight is shown.

It's one lab run, so scores move by a few points between runs. For a pull-request check with repeated runs and noise filtering, see [Perf Budget Guard](https://github.com/Gaurav3170/perf-budget-guard).

### `find_unoptimized_images`

Scans the project, skipping `node_modules` and build output, for:

- **image files:** over a size limit (default 200 kB), wider than a pixel limit (default 2560px), PNG or JPEG over 50 kB that WebP would shrink by about 25–34% ([Google's measurements](https://developers.google.com/speed/webp)), animated GIFs better served as video, and large SVGs;
- **`<img>` tags** in `.jsx`, `.tsx`, `.js`, HTML, Vue, Svelte, Astro and MDX files: no `width`/`height` (layout shift), no `alt`, no `loading` or `fetchpriority`, and, in a Next.js project, places `next/image` would help.

Image sizes are read from file headers, so nothing is decoded and no image library is installed. Tags with spread props (`{...props}`) aren't flagged for missing attributes, because the attributes may arrive at runtime. `<img>` inside strings, regexes and fenced code samples is ignored.

### `check_nextjs_upgrade`

Reads the installed Next.js version and the target's requirements from the registry, then reports:

- **Requirements:** Node.js, React and TypeScript versions, against what the target needs.
- **Peer conflicts:** direct dependencies whose `react` peer range rejects the target React, and the first version of each that accepts it.
- **Breaking changes in the code,** with `file:line` locations and the codemod for each. It covers every change between the two versions that a text scan can find reliably. Each change, with the version that introduced it:

| Version | Change |
| --- | --- |
| 15 | Sync `params`/`searchParams` |
| 15 | Sync `cookies()`/`headers()`/`draftMode()` |
| 15 | Uncached `GET` route handlers |
| 15 | Renamed config options |
| 15 | `@next/font` |
| 15 | `NextRequest.geo`/`ip` |
| 15 | `experimental-edge` |
| 16 | `middleware` → `proxy` |
| 16 | `next lint` |
| 16 | A custom `webpack` config under Turbopack |
| 16 | `experimental.turbopack` |
| 16 | Runtime config |
| 16 | AMP |
| 16 | `next/legacy/image` |
| 16 | `images.domains` |
| 16 | Sass `~` imports |
| 16 | One-argument `revalidateTag` |
| 16 | `unstable_` APIs |
| 16 | Removed PPR flags |
| 16 | Parallel routes without `default.js` |
| 16 | `scroll-behavior` |

- **The order to do it in,** one major at a time, with links to the official guides.

It's a pre-flight check, not a codemod. Behaviour changes, such as caching defaults, still need testing, and the report says so.

## Skills

Each skill is one `SKILL.md` in [`plugin/skills/`](plugin/skills). They all follow the same pattern:

1. **Gather facts** with the tools. Never guess a version, a size or a score.
2. **Plan the smallest change, then stop** for the user's approval.
3. **Apply it and prove it.** Run the project's own type check, lint, tests and production build, show the output, and re-run the tool to confirm the problem is gone. If a step fails, revert it and report.
4. **End with a person.** Ask before committing, never merge.

| Skill | What it does |
| --- | --- |
| `fix-vulnerable-dependencies` | Fixes npm advisories with the smallest upgrades, one verified step at a time. Never uses `npm audit fix --force` or `--legacy-peer-deps`. |
| `nextjs-upgrade` | Upgrades Next.js one major at a time: pre-flight scan, official codemods, peer upgrades, then resolves every `@next-codemod-error` the codemods leave. Doesn't switch on new features like the React Compiler as a side effect. |
| `accessibility-audit` | Lighthouse/axe on the production build, then a code review of what automation misses (keyboard, focus, names, forms, motion). Every issue is tied to a WCAG criterion and fixed in the shared component. |

Skills are plain Markdown, so they're easy to read before you trust them, and to change for your team's conventions.

## Architecture

```text
 Claude Code / Cursor / VS Code / any MCP client
        │  stdio (JSON-RPC)
        ▼
 src/cli.ts          no arguments → MCP server; "<tool> --flags" → print one report
        │
        ▼
 src/server.ts       registers each tool: zod input schema, readOnlyHint, errors as tool results
        │
        ├── tools/analyze-bundle.ts         .next manifests or HTML entry points → per-route gzip sizes
        ├── tools/audit-dependencies.ts     lockfile → advisories → fix planner → combined plan
        ├── tools/run-lighthouse.ts         headless Chrome + Lighthouse → scores, metrics, failing elements
        ├── tools/find-unoptimized-images.ts  file headers + <img> scan
        └── tools/check-nextjs-upgrade.ts   versions + peer ranges + source scan per breaking change
                │
                ▼
 lib/registry.ts     npm registry: abbreviated package metadata (cached) and the bulk advisory endpoint
 lib/inventory.ts    lockfile v2/v3 or node_modules → installed packages, Node's resolution, dependency chains
 lib/lighthouse.ts   optional: loaded on first use; one fresh Chrome per run, 120 s timeout

 .claude-plugin/marketplace.json   single-plugin marketplace; its entry points at ./plugin
 plugin/
   .claude-plugin/plugin.json      plugin manifest
   .mcp.json                       the plugin starts the published server with npx
   skills/*/SKILL.md               playbooks that call the tools, stop for approval and verify
```

A few decisions behind it:

- **Every tool is read-only.** The agent changes code with its own editing tools, where the user sees and approves each edit. A tool that silently ran `npm install` would bypass that.
- **Reports are markdown written for the agent.** Every report includes what the numbers mean and their limits ("one lab run", "static scan", "gzip is an estimate"), so the agent repeats the caveats instead of overstating results.
- **Expected failures come back as readable tool errors,** for example "`.next` holds a dev build: run the production build". The agent can recover instead of the call crashing.
- **The advisory endpoint only returns advisories that match the versions it's sent.** So the tool asks twice: first for installed versions (what's vulnerable?), then for every published version of each vulnerable package (which versions are safe?).
- **Lighthouse is optional.** It was 88% of the install (192 MB of 287 packages, against 22 MB without it), and the first `npx` start took about 80 seconds, past Claude Code's 30-second startup limit. Without it, a cold start takes about 15 seconds.
- **The plugin lives in `plugin/`, not at the repository root.** Claude Code runs `npm ci` on install for any plugin with a `package.json` and a lockfile at its root, with a 60-second limit and no way to turn it off. At the root, that installed this package's development tools, Lighthouse included, and timed out. The plugin needs none of them, because its server comes from npm, so it's kept in a folder with no `package.json`.
- **Outside services are injected.** The registry and Lighthouse are passed in, so the tests run offline against a fake registry and a saved Lighthouse result.

## Measurements

On the portfolio above (569 installed packages, 4 routes), Windows 11, Node.js 18.17, median of five runs from the command line, October 2026:

| Command | Median |
| --- | --- |
| `npm audit --json` (baseline) | 3.1 s |
| `audit_dependencies` | 5.2 s |
| `analyze_bundle` | 1.2 s |
| `find_unoptimized_images` | 1.2 s |
| `check_nextjs_upgrade` | 2.6 s |
| `run_lighthouse` (one page, mobile) | 12 to 25 s |

`audit_dependencies` takes about 2 seconds longer than `npm audit` because it downloads release metadata to plan the fixes. In return, it finds the smallest safe versions and the direct dependency to change for nested packages, where `npm audit` points at the latest release.

Accuracy on the same project: `audit_dependencies` reported the same four vulnerable packages as `npm audit`, and every suggested version was checked against the registry by hand (see the example above). In a Claude Code session with only these tools enabled, the agent answered "which route loads the most JavaScript, and what's the smallest set of upgrades that fixes every advisory?" with the exact numbers from the reports in 26 seconds.

## Limitations

- **Static scans can miss things and flag things.** `check_nextjs_upgrade` and `find_unoptimized_images` read source text. Unusual code (props passed through several components, config built at runtime) can hide a problem or trigger a false alarm. Every finding has a location, so it's quick to check.
- **One Lighthouse run is noisy.** Treat a few points' difference as noise. For decisions, compare several runs or use Perf Budget Guard.
- **Automated accessibility checks find a little over half of real issues** ([Deque's analysis](https://www.deque.com/automated-accessibility-testing-coverage/) measured 57%). The `accessibility-audit` skill adds a code review, but screen-reader and keyboard testing by a person is still needed.
- **pnpm isn't supported by `audit_dependencies` yet.** Its symlinked `node_modules` needs a different reader.
- **Public registry only.** Advisories and versions come from `registry.npmjs.org`. Private packages are skipped.
- **Interaction to Next Paint (INP) isn't measured.** It needs real user input. Total Blocking Time is the closest lab signal.

## Development

```sh
npm install
npm test            # 61 tests, offline (node:test)
npm run typecheck
npm run build       # compiles to dist/
node scripts/smoke.mjs /absolute/path/to/a/project   # start the built server over stdio and call a tool
claude plugin validate .        # the marketplace
claude plugin validate plugin   # the plugin
```

The tests use temporary projects, a fake registry that behaves like the real advisory endpoint, and a trimmed real Lighthouse 12.8.2 result in `test/fixtures/`.

## License

[MIT](LICENSE) © 2026 Gaurav Keswani
