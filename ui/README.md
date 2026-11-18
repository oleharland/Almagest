# ui/: the shared design library

Plain CSS and two font files. No dependencies, no build step. Both frontends take their look from here and from nowhere else:

- the wiki site (`site/`) imports the three CSS files from `site/src/styles/base.css`
- the review inbox (`server/src/governance/web/layout.mjs`) reads them once at start and inlines them under the CSP nonce

If something looks wrong in both, fix it here. Do not restyle the same thing in the site or the inbox.

```
ui/
  tokens.css       primitives and semantic tokens, light and dark
  base.css         @font-face, reset, document type, focus, selection, layout primitives
  components.css   the al- component classes
  fonts/           GeistVariable.woff2, GeistMonoVariable.woff2, OFL.txt, SOURCE.txt
```

Geist and Geist Mono are published by Vercel under the SIL Open Font License 1.1. The licence is in `fonts/OFL.txt`.

## Themes

Light is the default. Dark follows `prefers-color-scheme`. Force either with `data-theme="light"` or `data-theme="dark"` on `<html>` (the site's theme switch does this). `data-theme` on any element scopes a theme to it, which the gallery uses.

An instance themes both frontends in `site/src/styles/theme.css`, which loads last. Redefine semantic tokens, and repeat them for dark:

```css
:root { --accent: #0f766e; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --accent: #5eead4; } }
:root[data-theme="dark"] { --accent: #5eead4; }
```

## Tokens

- Surfaces: `--surface`, `--surface-secondary`, `--surface-tertiary`, `--surface-inverse`
- Text: `--content`, `--content-secondary`, `--content-tertiary`, `--content-inverse`. Tertiary is for small meta text on `--surface` or `--surface-secondary` only.
- Borders (alpha): `--border-subtle`, `--border`, `--border-strong`
- Accent: `--accent`, `--accent-hover`, `--accent-soft`, `--accent-content`, `--focus-ring`, `--selection`
- Status: `--success`, `--warning`, `--danger`, `--info`, each with `-soft`
- Tier: `--tier-canonical`, `--tier-curated`, `--tier-evidence`
- Diff: `--diff-add`, `--diff-add-mark`, `--diff-add-content`, `--diff-del`, `--diff-del-mark`, `--diff-del-content`
- Primitives: `--color-ink-50..950`, `--color-blue-*`, `--color-teal-*`, `--color-red-*`, `--color-green-*`, `--color-amber-*`, `--color-brand-blue`
- Widths: `--width-measure` (70ch, prose), `--width-page` (1120px), `--width-wide` (1440px), with `--gutter` and `--gutter-wide`
- Spacing: `--space-0` (2px), `--space-1` (4px), `--space-2` (8px), `--space-3` (12px), `--space-4` (16px), `--space-5` (24px), `--space-6` (32px), `--space-7` (48px), `--space-8` (64px)
- Type: `--text-xs` (12px), `--text-sm` (13px), `--text-base` (15px), `--text-md` (17px), `--text-lg` (20px), `--text-xl` (24px), `--text-2xl` (32px), `--text-3xl` (40px); `--leading-*`, `--tracking-*`, `--weight-*`
- Shape and chrome: `--radius-sm` (4px), `--radius` (6px), `--radius-lg` (8px), `--radius-full`, `--appbar-height`, `--pane-width`, `--control-height*`
- Fonts and motion: `--font-sans`, `--font-mono`, `--duration`, `--ease`

The dark text ramp is one stop lighter than the owner's site (secondary ink-300, tertiary ink-400) so secondary text passes WCAG AA on all three dark surfaces.

## Layout

A page picks one named width. Nothing sets its own pixel width.

- `al-page`: standard, for lists and ordinary pages
- `al-page al-page--measure`: reading measure, for prose
- `al-page al-page--wide`: review work, 1440px with fluid side padding

The app bar's inner container takes the same modifier as the page below it, so the brand and the content share one left edge. The site uses the standard width. The inbox uses standard for lists and wide for a proposal.

Other primitives: `al-main`, `al-stack` (`--sm`, `--lg`), `al-cluster` (`--lg`, `--end`, `--between`), `al-grow`, `al-flow` (document rhythm), `al-pagehead`, `al-lede`, `al-section` (`__title`, `__count`), `al-prose`, `al-text-secondary`, `al-text-tertiary`, `al-text-warning`, `al-mono`, `al-visually-hidden`, `al-skip-link`.

## Components

All in `components.css`, prefix `al-`, BEM-like.

- `al-appbar` (`__inner`, `__brand`, `__brand-sub`, `__nav`, `__link` with `aria-current="page"`, `__count`, `__end`, `__name`): sticky bar with navigation and counts
- `al-btn` (`--primary`, `--quiet`, `--danger`, `--sm`, `--lg`, `--block`; works on `<a>`; `disabled` or `aria-disabled`)
- `al-link-arrow` (`--back`): ink link with an arrow
- `al-badge` (`--quiet`), `al-tier` (`--canonical`, `--curated`, `--evidence`), `al-chip` (`--success`, `--warning`, `--danger`, `--info`)
- `al-card` (`--flush`, `--interactive`, `--muted`; `__head`, `__body`, `__foot`, `__title`), `al-panel` (`--success`)
- `al-list`, `al-list__item`, `al-row` (`__title`, `__summary`, `__meta`, `__line`, `__chips`)
- `al-table-wrap`, `al-table` (`__num`)
- `al-field`, `al-label`, `al-hint`, `al-error`, `al-input`, `al-select`, `al-textarea`, `al-check` (checkbox and radio), `al-search`
- `al-callout` (`--info`, `--success`, `--warning`, `--danger`; `__title`)
- `al-tabs` (`__tab`), `al-segmented` (`__item`)
- `al-kbd`, `al-empty` (`__title`), `al-pagination` (`__link`, `__gap`), `al-breadcrumb`
- `al-dl` (`--mono`, `--stacked`): metadata list
- `al-code`, `al-pre` (`--wrap`, `--preview`)
- `al-diff` (`--split`; `__hunk`, `__line` with `--add`, `--del`, `--ctx`, `--empty`; `__ln`, `__code`, `__row`, `__ins`, `__rem`)
- `al-twopane` (`--left`, `--side-first`; `__main`, `__side`): sticky side pane
- `al-actionbar` (`__inner`, `__msg`): sticky bottom bar
- `al-skeleton` (`--line`, `--short`, `--block`): static, no shimmer
- `al-details`: disclosure
- `al-claim` (`--add`, `--change`, `--remove`; `__op`, `__text`, `__was`, `__source`, `__missing`), `al-source` (`--missing`), `al-quote`, `al-decision` (`--resolved`; `__vs`, `__side`, `__options`)
- `al-narrow`, `al-stats`, `al-stat`

## Rules of the look

Quiet surfaces with 1px alpha borders, small radii and no shadow. Blue is for focus, selection and the one primary action on a screen. Links are ink with a quiet underline. Motion is limited to short colour and opacity transitions, and none under `prefers-reduced-motion`. Hover styles sit behind `@media (hover: hover)`. Never put a `style=` attribute in inbox markup: the CSP forbids it, use a class.

## The gallery

Every component in every state, light and dark side by side, is a dev-only route of the site:

```sh
cd site
npx -y node@22.23.4 node_modules/astro/bin/astro.mjs dev --port 4411
# open http://localhost:4411/gallery/
```

It is injected by `site/astro.config.mjs` only for `astro dev`, from `site/src/dev/`, so a production build does not contain it. Add new components to `site/src/dev/GalleryBody.astro`.
