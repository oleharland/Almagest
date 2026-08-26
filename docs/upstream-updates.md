# Upstream Updates

How to pull framework improvements into your brain instance.

## Setup

Add the Almagest framework as an upstream remote (one-time):

```bash
git remote add upstream <almagest-framework-repo-url>
```

## Pulling updates

```bash
git fetch upstream
git merge upstream/main
```

## What merges cleanly

| File type | Why it works |
|-----------|-------------|
| `brain/rules-index.md` | You didn't edit it — upstream's version replaces yours |
| `agent/contract.md`, `agent/rules/*` | Framework-owned. Generic logic; your customization is in `brain.config.yaml` |
| `tools/*` | Framework-owned |
| `benchmarks/drivers/*` | Framework-owned — unless you wrote a driver of your own (see below) |
| `site/src/components/*` | Framework owns components, you only customize `theme.css` |
| `site/src/lib/wiki.ts` | The loader — unless you edited `WIKI_DIRS` for multi-brain (see below) |
| `site/package.json` | Framework owns the dependency set |
| `site/src/layouts/*` | Same — framework-owned |
| `site/src/pages/*` | New pages add cleanly, existing pages update |
| `site/src/styles/base.css` | Framework design system — your overrides are in `theme.css` |

## What never conflicts

| Path | Why |
|------|-----|
| `brain/wiki/*` | Upstream ships only `_example.md` — your content is yours |
| `brain/raw/*` | Upstream ships only `.gitkeep` |
| `brain/index.md` | Your catalog, upstream's is empty template |
| `brain/log.md` | Your audit trail, upstream's is empty template |
| `brain.config.yaml` | Your config, upstream ships example values |
| `site/src/styles/theme.css` | Your theme, upstream ships it empty |
| `site/site.config.ts` | Your site config |
| `site/dist/`, `site/node_modules/` | Gitignored |

## Generated files

`AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md`, `.claude/rules/*`, `.cursor/rules/*`, and `brain/CLAUDE.md` are generated from `agent/rules/` by `tools/agent-shims.sh`. They are committed, so a rules change upstream shows up as a diff in all of them at once.

If one conflicts, do not merge it by hand:

```bash
git checkout --theirs <file>   # take upstream
tools/agent-shims.sh generate  # then regenerate everything
tools/agent-shims.sh check     # exits 1 if anything is still out of sync
```

## What might conflict

If you've edited a framework-owned file, the merge will show a conflict. This is the right behavior — you see exactly what upstream changed and decide how to integrate.

The most likely one is `site/src/lib/wiki.ts` if you added brains to `WIKI_DIRS`. Keep your array, take upstream's everything-else. The second most likely is a rule file you edited in place — move the edit into `brain.config.yaml` if it is instance-specific, or keep it and expect it back at every merge.

### Resolving conflicts

```bash
# After merge conflict:
git diff          # see what conflicted
# Edit the file to combine your changes with upstream's
git add <file>
git commit
```

## Recommended workflow

1. **Pull regularly** — small, frequent merges are easier than big ones
2. **Don't edit framework files** unless you have to — put customization in config
3. **Review the diff** before merging: `git diff upstream/main`
4. **Test after merge**: `tools/agent-shims.sh check`, then `cd site && npm run build`
