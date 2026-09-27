# PAI/TOOLS — Project Rules

## Library Pipeline

When GP says "ingest books", "update the library", or "add books to the library":

1. `cd ~/.claude/PAI/TOOLS`
2. `bun LibraryClassify.ts --mount /mnt/unraid-books` — reclassify all books, update manifest
3. `bun LibraryIngest.ts` — incremental ingest (only processes books not already in KNOWLEDGE/Library/)

Both steps together take under 30 seconds. Always run classify first so new books get a tier before ingest reads the manifest.

To force re-ingest everything: `bun LibraryIngest.ts --full`
To check readiness: `bun LibraryIngest.ts --preflight`
