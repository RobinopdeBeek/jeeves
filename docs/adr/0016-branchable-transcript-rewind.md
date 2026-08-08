# Branch-aware Project Chat transcripts and server rewind

Project Chat transcripts are stored as a **branch-aware** tree (messages with `parentId` plus an active `headId`), not only a flat `UIMessage[]`. Edit and branch switching go through a server **rewind**: truncate or switch the active head, close that Chat Thread's warm ACP process, respawn, and seed-once from the rewound active path on the next user turn — so the agent cannot continue from discarded branch context. Durable rewind stands even if warm respawn fails; the outcome reports warm status explicitly. Corrupt transcript files fail closed (file preserved). Legacy flat transcript files migrate on load. Step-chat transcripts stay flat. Project Chat WS `ready` (and rewind responses) carry the full branchable tree alongside the active path.

## Considered Options

- **Client-only message-array edits** — rejected: leaves the warm ACP on the old context; fails US 52 and the edit/branch testing decision in #33.
- **Delete discarded branch messages on truncate** — rejected: branch picking (#42) needs siblings retained.
- **Persist preferred-child (`next`) pointers** — deferred: tip-of-branch walks last-linked children; enough for v1 switch/edit.
