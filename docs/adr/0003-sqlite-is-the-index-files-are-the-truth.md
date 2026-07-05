# SQLite is the index, files are the truth for file-shaped artifacts

Artifacts have two natures pulling in different directions: prose and media want to be editable, diffable files; the board wants queryable rows. We split by nature — the `artifacts` table holds metadata plus a path, never content, and every file-shaped artifact lives in the artifact folder — rather than storing blobs in SQLite or parsing files to render the UI. Every prose artifact carries YAML frontmatter (`card_id, step, round, kind, source_skill, derived_from, git_sha, schema_version, created_at`) so files are self-describing and the index is rebuildable from disk if the database is lost.

## Consequences

- Nothing the UI renders on a card tile may be trapped inside markdown or HTML; if the board needs it, it must be a row (this is why notifications arrive as a sidecar JSON that is inserted into the database at harvest, not scraped from the evaluation HTML).
- Structured state (change requests, runs, decisions) gets real tables, never markdown files.
- Backup and the VPS migration are "copy the SQLite file + `data/`".
