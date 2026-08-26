# Corpus — treatment arm

The working directory contains:

- `wiki/` — compiled Almagest knowledge pages, flat markdown, cross-linked with
  `[[wikilinks]]`. Each page carries frontmatter (`tier`, `confidence`,
  `origin`, `sources`), inline `[source: ...]` citations, and an
  `## Open questions` section naming what is not known.
- `index.md` — the catalog of every page and every source, beside `wiki/`.
  **Read this first.**
- `sources/` — the original raw documents the wiki was compiled from.

## How a citation on a page works

Every page declares its sources in frontmatter as objects:

```yaml
sources:
  - id: kb-02-survey
    path: raw/kb-02-site-survey-report.md
    sha256: "0302…"
    title: "MCA-SUR-0014 Kestrel Basin Physical Site Survey Report"
```

An inline citation names the `id` and a location inside it:

```
[source: kb-02-survey, §3, (2027-04-11)]
```

So `[source: kb-02-survey, §3]` means *section 3 of the document whose title is
`MCA-SUR-0014 Kestrel Basin Physical Site Survey Report`*. `index.md` carries
the same mapping in a table.

## Citing in your answer

Cite two things for every claim:

1. **The wiki page**, as `[[page-slug]], §Section` — so the reader can get the
   full context.
2. **The original source**, named by its document ID and section, as
   `Original: MCA-SUR-0014 Site Survey Report, §3` — so the reader can verify.

The wiki page is the index; the original source is the authority. A wiki page
citation on its own is not sufficient.

A page is a compiled artifact, not the document. Where a page and the source it
cites disagree, the source wins and the disagreement is itself worth reporting.
