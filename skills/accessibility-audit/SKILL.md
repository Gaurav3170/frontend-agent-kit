---
name: accessibility-audit
description: Audit a web app's pages for accessibility, combining automated axe-core checks from Lighthouse with a code review of what automation can't see, then fix the issues with the smallest change to the right component. Use when asked for an accessibility (a11y) audit, a WCAG review, or to fix accessibility issues on a page.
argument-hint: "[URL or route, e.g. http://localhost:3000/checkout]"
---

# Accessibility audit

Pages to audit: `$ARGUMENTS`. If empty, ask which routes matter most. Usually that's the home page, a listing page, a detail page and any form or checkout flow.

Automated tools find a little over half of real accessibility problems. You'll run them first, then review the code for the rest, and fix issues **in the shared component**, not page by page.

Rules for the whole job:

- **Audit the production build.** Build and start the app (`npm run build && npm run start`, or the project's equivalent). Dev builds include overlays and extra markup that skew the results.
- **Name the WCAG success criterion** for every issue, e.g. "1.4.3 Contrast (Minimum)". That lets the user judge its priority.
- **Don't reach for ARIA first.** A native element (`<button>`, `<label>`, `<a href>`) beats an ARIA role every time. Incorrect ARIA is worse than none.
- **Never claim a page "is accessible".** Say what you checked and what still needs a person: screen-reader testing and real keyboard use.

## Phase 1: Automated checks

1. Confirm the production server is running and note its URL.
2. For each page, call `run_lighthouse` with `categories: ["accessibility"]` (add `"performance"` if the user wants both). Record every failing audit, the elements it lists (selector and HTML snippet), and the score.
   - If it says Lighthouse isn't installed, show the user the command from the message and ask whether to set it up. Don't install anything yourself. If they'd rather not, run `npx -y @axe-core/cli <url>` (axe-core, the same rule engine) if they agree, or continue with Phase 2 only and say the automated checks were skipped.
3. Rules marked "Not counted in the score" are still real issues. Include them.
4. Call `find_unoptimized_images` with `projectDir`. Its "no alt" findings show images in the source that may have no text alternative, including on pages you didn't audit.

## Phase 2: Review what automation can't see

Read the components behind each page (find them from the selectors and snippets). Check:

- **Keyboard:** every interactive element can be reached with Tab and used with Enter or Space. Look for `onClick` on `<div>` or `<span>`, `tabIndex` greater than 0, and custom dropdowns, modals and carousels.
- **Focus:** a visible focus style (search the CSS for `outline: none` or `outline: 0` without a replacement). Dialogs move focus in, trap it, and return it on close. Route changes in a single-page app move focus or announce the new page.
- **Names:** icon-only buttons and links have an accessible name. Repeated "Read more" or "Click here" links say where they go. A visible label matches the accessible name (WCAG 2.5.3).
- **Forms:** every input has a `<label>` (a placeholder isn't one). Errors are announced (`aria-live` or `aria-describedby`) and say how to fix them. Required fields are marked in text, not only with colour.
- **Structure:** one `<h1>` per page, headings in order, landmarks (`<main>`, `<nav>`, `<header>`, `<footer>`), and a skip link if the navigation is long.
- **Motion:** animations respect `prefers-reduced-motion`. Auto-playing content can be paused.
- **Images:** `alt` describes the image's purpose in context. Decorative images use `alt=""`.

## Phase 3: Report, then STOP

Present the issues grouped by component, highest impact first:

| Issue | WCAG | Where (component, file:line) | Pages affected | Found by | Proposed fix |
| --- | --- | --- | --- | --- | --- |

"Found by" is "Lighthouse/axe" or "code review", so the user knows which issues a tool confirmed. Put issues that block a task (can't submit the form with a keyboard, no name on the checkout button) above cosmetic ones.

**Wait for approval** before fixing.

## Phase 4: Fix and verify

1. Fix each approved issue in the component it comes from, with the smallest change: prefer swapping in the right native element over adding attributes.
2. Run the project's type check, lint and tests. If the project has accessibility lint rules (`eslint-plugin-jsx-a11y`) or component tests, run them.
3. Rebuild, restart the production server, and call `run_lighthouse` again on every audited page. Show the before and after for each failing audit.
4. For keyboard and focus fixes, describe exactly how you checked the behaviour, e.g. "Tab from the search box reaches the filter button and Enter opens it". If you couldn't check it, say so, so a person can.
5. Show `git diff --stat`, and **ask before committing**. List what still needs a manual check with a screen reader (VoiceOver, NVDA) and a keyboard.
