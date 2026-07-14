# SQLite is the index, files are the truth for file-shaped artifacts

Artifacts have two natures pulling in different directions: prose and media want to be editable, diffable files; the board wants queryable rows. We split by nature — the `artifacts` table holds metadata plus a root-relative path, never content, and every file-shaped artifact lives in the artifact folder — rather than storing blobs in SQLite or parsing files to render the UI. Markdown prose carries YAML frontmatter (`card_id, step, round, kind, source_skill, derived_from, git_sha, schema_version, created_at`); self-contained HTML carries equivalent `<meta>` elements or an HTML comment so metadata does not precede and break the document. The index is rebuildable from these self-describing files if the database is lost.

## Consequences

- Nothing the UI renders on a card tile may be trapped inside markdown or HTML; if the board needs it, it must be a row (this is why notifications arrive as an exchange file inserted into the database at harvest, not scraped from the evaluation HTML).
- Structured state (change requests, runs, decisions) gets real tables, never markdown files.
- `ArtifactStore` alone resolves paths and rejects any resolution outside the configured artifact root.
- Saves are file-first: write and validate a temporary file, atomically rename it, then insert the SQLite row. A normal insert failure removes the file; a crash between rename and insert leaves a recoverable self-describing orphan rather than a broken database pointer.
- Backup and the VPS migration are "copy the SQLite file + `data/`".
