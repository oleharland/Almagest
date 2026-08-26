# Page Types

Wiki page types are defined in `brain.config.yaml` → `page_types`. Each type represents a distinct editorial purpose in your knowledge base.

## Defining types

```yaml
# brain.config.yaml
page_types:
  - topic
  - concept
  - decision
  - reference
  - entity
  - claim
```

The agent validates the `type` field in every wiki page's frontmatter against this list. An invalid value is audit check `SCHEMA-002`.

| Type | For |
|---|---|
| `topic` | A broad subject area or domain cluster |
| `concept` | A defined term or abstract idea worth explaining |
| `decision` | A recorded architectural or strategic decision (ADR-style) |
| `reference` | Stable lookup material — standards, specs, glossaries |
| `entity` | A real-world thing: a product, org, person-role, or system |
| `claim` | **Your** conclusion, not a source's. See below |

`type` and the `type_fields` vocabularies are separate lists. An organisation is `type: entity` with `entity_type: organisation` — never `type: organisation`. Mixing them is `SCHEMA-005`.

## The `claim` type

A `claim` page records a conclusion you reached, not a fact a document states.

- Normally `origin: self`, so its body carries **no inline citations**.
- Required in exchange: a `## Basis` section whose bullets are `[[wikilinks]]` to `origin: source` pages.
- Title it as a **sentence**, not a noun phrase — "Availability warranties transfer O&M risk to the vendor", not "Warranties". The title is the claim.
- Usually `tier: curated`. `confidence: low` on a curated page blocks the ingest commit; if you can't get past `low`, it belongs at evidence tier or in `## Open questions` on an existing page.

Why the type exists: before `origin`, every body claim needed a citation to an ingested source, which made your own judgment a schema violation. `claim` + `origin: self` makes it first-class, and `## Basis` keeps it accountable — an uncited conclusion still has to say what it stands on.

## `origin` — whose claim is this?

| Value | Means | Citation obligation |
|---|---|---|
| `source` (default) | Claims derive from ingested material | Every body claim carries an inline citation `[source: <id>, <locator>]` |
| `self` | The author's own conclusion | Body claims need no citation; the page MUST have a `## Basis` section of `[[wikilinks]]` to `origin: source` pages |

`origin` is per page, not per type. A `topic` page can be `origin: self` if it is genuinely your synthesis; a `claim` page could in principle be `origin: source` if you are recording someone else's argument. The obligations follow `origin`, never `type`.

Audit: `CITE-003` (unsourced body block on an `origin: source` page), `CITE-004` (`origin: source` with empty `sources`), `CITE-006` (`origin: self` with no or non-wikilink `## Basis`).

## Adding type-specific requirements

Use `type_fields` to define extra requirements for specific page types:

```yaml
type_fields:
  decision:
    - decision_date
    - decision_status       # proposed | accepted | superseded | deprecated
    - options               # list of alternatives considered
  entity:
    - entity_type           # product | organisation | system | role
  claim:
    - "section:## Basis"    # a required BODY section, not a frontmatter key
```

An entry prefixed `section:` names a required **body section**. Everything else is a frontmatter key. Frontmatter keys are added to the base template when creating a page of that type; a missing one is `SCHEMA-003`.

## Base fields (all types)

Schema **v2**. Every page gets these regardless of type:

| Field | Required | Description |
|-------|----------|-------------|
| `title` | yes | Human-readable page title. A sentence for `type: claim` |
| `type` | yes | Must be in `brain.config.yaml` → `page_types` |
| `tier` | yes | `canonical`, `curated`, or `evidence` |
| `origin` | yes | `source` (default) or `self` |
| `status` | yes | `stub`, `draft`, or `evergreen` |
| `confidence` | yes | `high`, `medium`, `low`, or `unknown` |
| `tags` | no | Lowercase filter tags |
| `aliases` | no | Alternative names for this page's subject. **Base field in v2** — was `entity`-only |
| `owner` | no | Required only when `require_owner: true`, in which case it must be in `owner_teams` |
| `date_created` | yes | ISO date |
| `date_modified` | yes | ISO date |
| `last_verified` | no | ISO date — last human check. Drives `STALE-001` |
| `sources` | yes* | List of **objects** — `id`, `path`, `sha256`, optional `title`. May be empty only when `origin: self` |
| `related` | no | Untyped "see also" `[[wikilinks]]` |
| `relations` | no | Typed edges — see below |

### `sources` is a list of objects now

```yaml
sources:
  - id: kb-02-site-survey                                        # unique within this page
    path: brain/raw/extracted/kb-02-site-survey-report.pdf.txt   # sidecar for binary sources
    sha256: "9f2a…"                                              # 64 hex, must match manifest.yaml
    title: "MCA-SUR-0014 Site Survey Report"                     # optional human label
```

`id` exists so citations can be checked mechanically. The citation grammar is frozen:

```
[source: <id>, <locator>]
[source: <id>, <locator>, (<date>)]
[source: unknown]
```

`<locator>` is one of `§<section>` · `p.<n>` · `pp.<n>-<m>` · `row <n>` · `slide <n>` · `t <hh:mm:ss>` · `line <n>`. The old prose form — `[source: System Documentation / Architecture, §Failover, p.3]` — is **retired**; the human label lives in `sources[].title`.

### Typed relations

`related` stays as the untyped "see also". `relations` records edges that carry logical force:

| Key | Means | Use when |
|---|---|---|
| `supports` | This page argues **for** the target | Your evidence backs another page's claim |
| `contradicts` | This page is **incompatible** with the target | Both cannot be true. Record it on both pages |
| `supersedes` | This page **replaces** the target | The target stays, marked, rather than being deleted |
| `depends_on` | This page **rests on** the target | If the target falls, this page falls |

```yaml
relations:
  contradicts:
    - "[[legacy-failover-model]]"
  depends_on:
    - "[[site-survey-2026-q2]]"
```

`contradicts` is what makes the contradiction protocol machine-checkable — a disputed pair is a graph edge the audit reads and the site renders, instead of a convention nobody can verify after the fact. A `relations` target that does not exist is `LINK-003`.

## Example: adding a custom type

To add a `process` type for documenting workflows:

1. Add to `brain.config.yaml`:
   ```yaml
   page_types:
     - topic
     - concept
     - decision
     - reference
     - entity
     - claim
     - process           # new

   type_fields:
     process:
       - steps            # ordered list of process steps
       - owner_role       # who executes this process
       - frequency        # how often it runs
   ```

2. The agent will now accept `type: process` in wiki pages and prompt for the extra fields when creating one, and `tools/audit.mjs` will enforce them as `SCHEMA-003`.

## Worked examples

- `brain/wiki/_example.md` — `origin: source`, object-form `sources`, inline citations
- `brain/wiki/_example-claim.md` — `type: claim`, `origin: self`, `## Basis`, `depends_on`

Delete both when you create your first real page.
