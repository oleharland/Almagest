# Corpus — treatment arm

The working directory contains:

- `wiki/` — compiled Almagest knowledge pages, flat markdown, cross-linked with
  `[[wikilinks]]`. Each page carries frontmatter (`tier`, `confidence`,
  `sources`), inline `[source: ...]` citations, and an `## Open questions`
  section naming what is not known.
- `wiki/index.md` — the catalog of every page and every source. **Read this
  first.**
- `sources/` — the original raw documents the wiki was compiled from.

Cite two things for every claim:

1. **The wiki page**, as `[[page-slug]], §Section` — so the reader can get the
   full context.
2. **The original source** behind that claim, as
   `Original: MCA-SUR-0014 Site Survey Report, §3` — so the reader can verify.

The wiki page is the index; the original source is the authority. A wiki page
citation on its own is not sufficient.
