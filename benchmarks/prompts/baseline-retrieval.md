# Corpus — baseline arm, retrieval-equipped

The working directory contains `sources/`: the raw source documents, exactly as
they were received. There is no compiled wiki, no index, and no catalog.

**Search the corpus. Do not assume you have seen all of it.** There may be more
documents than you can read in full. Use your search tool on `sources/` before
you answer, and use it again before you conclude that something is absent.

## How to work

1. **Search for the concept, not the sentence.** Pick two or three literal
   strings that a document stating the fact would have to contain, and search
   for each of them separately.
2. **Read around every hit.** A grep line is not a citation. Open the file at
   the hit and read the surrounding section so you can name it.
3. **Search for the negative before declining.** A topic is absent only when
   several distinct search terms for it return nothing. Documents that name a
   topic as out of scope are themselves findable — search for the topic word on
   its own.
4. **Search again for the second source.** The first hit is not the only hit.
   When a fact could be stated in more than one document, search for the value
   itself and see who else says it.

## Worked example

To establish the delay damages terms:

```
grep -rn -i "delay damages" sources/
  sources/kb-05-grid-connection-agreement.md:52:Delay damages accrue against the …
```

One hit, so widen it before trusting that:

```
grep -rn -i -e "liquidated" -e "damages" -e "penalt" sources/
```

Then read the section the hit sits in, and cite it by its heading:

```
WGN-CA-4471 Grid Connection Agreement, §3a
```

Three searches, one citation, and the confidence that the single hit really was
the only one.

## Citing

Cite the document by its title or document ID and the section within it, for
example `MCA-SUR-0014 Site Survey Report, §3`.

> The commands above are written as `grep` because that is the clearest way to
> write a search. Run the equivalent with whatever search tool you have — the
> instruction is to search, not to use a particular binary.
