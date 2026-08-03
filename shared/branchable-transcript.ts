import type { UIMessage } from "ai";

/** One node in a branch-aware transcript tree. */
export type BranchNode = {
  parentId: string | null;
  message: UIMessage;
};

/**
 * Server-owned branch-aware transcript: message tree + active head.
 * Active path (root → head) is what ACP seed-once and WS `ready` use.
 */
export type BranchableTranscript = {
  version: 1;
  headId: string | null;
  messages: BranchNode[];
};

/** POST /api/chat-threads/:id/rewind body. */
export type RewindOp =
  | { action: "truncate"; headId: string | null }
  | { action: "switch"; branchId: string };

export function emptyTranscript(): BranchableTranscript {
  return { version: 1, headId: null, messages: [] };
}

/** Linear chat → single-branch tree (parent = previous message). */
export function fromLinear(messages: UIMessage[]): BranchableTranscript {
  if (messages.length === 0) return emptyTranscript();
  return {
    version: 1,
    headId: messages[messages.length - 1]!.id,
    messages: messages.map((message, idx) => ({
      parentId: idx === 0 ? null : messages[idx - 1]!.id,
      message,
    })),
  };
}

/** Thrown when on-disk Project Chat transcript JSON fails validation. */
export class TranscriptParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptParseError";
  }
}

/**
 * Accept on-disk JSON: legacy flat `UIMessage[]` or v1 branchable object.
 * Fail closed — corrupt / unknown shapes throw `TranscriptParseError`
 * (callers preserve the file; do not silently empty).
 */
export function parseTranscriptFile(raw: unknown): BranchableTranscript {
  if (Array.isArray(raw)) {
    const messages = raw.map((item, i) => parseUiMessage(item, `messages[${i}]`));
    return fromLinear(messages);
  }
  if (!raw || typeof raw !== "object") {
    throw new TranscriptParseError("transcript must be an array or v1 object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new TranscriptParseError(
      `unsupported transcript version: ${String(obj.version)}`,
    );
  }
  if (!Array.isArray(obj.messages)) {
    throw new TranscriptParseError("v1 transcript requires messages: array");
  }
  if (obj.headId != null && typeof obj.headId !== "string") {
    throw new TranscriptParseError("headId must be string | null");
  }

  const nodes: BranchNode[] = obj.messages.map((item, i) =>
    parseBranchNode(item, `messages[${i}]`),
  );
  const transcript: BranchableTranscript = {
    version: 1,
    headId: (obj.headId as string | null | undefined) ?? null,
    messages: nodes,
  };
  assertTreeInvariants(transcript);
  return transcript;
}

function parseUiMessage(raw: unknown, path: string): UIMessage {
  if (!raw || typeof raw !== "object") {
    throw new TranscriptParseError(`${path} must be an object`);
  }
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== "string" || !m.id) {
    throw new TranscriptParseError(`${path}.id must be a nonempty string`);
  }
  if (typeof m.role !== "string" || !m.role) {
    throw new TranscriptParseError(`${path}.role must be a nonempty string`);
  }
  if (!Array.isArray(m.parts)) {
    throw new TranscriptParseError(`${path}.parts must be an array`);
  }
  return m as UIMessage;
}

function parseBranchNode(raw: unknown, path: string): BranchNode {
  if (!raw || typeof raw !== "object") {
    throw new TranscriptParseError(`${path} must be an object`);
  }
  const n = raw as Record<string, unknown>;
  if (n.parentId != null && typeof n.parentId !== "string") {
    throw new TranscriptParseError(`${path}.parentId must be string | null`);
  }
  return {
    parentId: (n.parentId as string | null | undefined) ?? null,
    message: parseUiMessage(n.message, `${path}.message`),
  };
}

function assertTreeInvariants(t: BranchableTranscript): void {
  const ids = new Set<string>();
  for (const node of t.messages) {
    const id = node.message.id;
    if (ids.has(id)) {
      throw new TranscriptParseError(`duplicate message id: ${id}`);
    }
    ids.add(id);
  }
  for (const node of t.messages) {
    if (node.parentId != null && !ids.has(node.parentId)) {
      throw new TranscriptParseError(
        `parent id not found: ${node.parentId} (child ${node.message.id})`,
      );
    }
  }
  if (t.headId != null && !ids.has(t.headId)) {
    throw new TranscriptParseError(`headId not found: ${t.headId}`);
  }
  const byId = new Map(t.messages.map((n) => [n.message.id, n]));
  for (const node of t.messages) {
    const seen = new Set<string>();
    let id: string | null = node.message.id;
    while (id != null) {
      if (seen.has(id)) {
        throw new TranscriptParseError(`cycle detected at message id: ${id}`);
      }
      seen.add(id);
      id = byId.get(id)?.parentId ?? null;
    }
  }
}

function nodeMap(t: BranchableTranscript): Map<string, BranchNode> {
  return new Map(t.messages.map((n) => [n.message.id, n]));
}

function childrenOf(
  t: BranchableTranscript,
  parentId: string | null,
): string[] {
  return t.messages
    .filter((n) => n.parentId === parentId)
    .map((n) => n.message.id);
}

/** Walk to the tip preferring the last-linked child at each step. */
function tipFrom(t: BranchableTranscript, messageId: string): string {
  let id = messageId;
  for (;;) {
    const kids = childrenOf(t, id);
    if (kids.length === 0) return id;
    id = kids[kids.length - 1]!;
  }
}

/** Parent id of a message in the tree, or null if root / unknown. */
export function parentIdOf(
  t: BranchableTranscript,
  messageId: string,
): string | null {
  return nodeMap(t).get(messageId)?.parentId ?? null;
}

/** Active path from root to `headId` (empty when head is null). */
export function activePath(t: BranchableTranscript): UIMessage[] {
  if (t.headId == null) return [];
  const byId = nodeMap(t);
  const path: UIMessage[] = [];
  let id: string | null = t.headId;
  const seen = new Set<string>();
  while (id != null) {
    if (seen.has(id)) break;
    seen.add(id);
    const node = byId.get(id);
    if (!node) break;
    path.push(node.message);
    id = node.parentId;
  }
  path.reverse();
  return path;
}

/**
 * Sibling branch ids for a message (same parent), including itself.
 * Empty when the message is unknown.
 */
export function getBranches(
  t: BranchableTranscript,
  messageId: string,
): string[] {
  const node = nodeMap(t).get(messageId);
  if (!node) return [];
  return childrenOf(t, node.parentId);
}

/** Make `branchId`'s tip the active head (keeps off-path siblings). */
export function switchToBranch(
  t: BranchableTranscript,
  branchId: string,
): BranchableTranscript {
  if (!nodeMap(t).has(branchId)) {
    throw new Error(`unknown branch id: ${branchId}`);
  }
  return { ...t, headId: tipFrom(t, branchId) };
}

/**
 * Set the active head exactly to `headId` (or empty). Off-path messages stay
 * in the tree so a later append under this head forks a sibling branch.
 */
export function truncateTo(
  t: BranchableTranscript,
  headId: string | null,
): BranchableTranscript {
  if (headId == null) {
    return { ...t, headId: null };
  }
  if (!nodeMap(t).has(headId)) {
    throw new Error(`unknown message id: ${headId}`);
  }
  return { ...t, headId };
}

/**
 * Merge a flat active-path snapshot (from AcpBridge) into the tree.
 * Preserves off-path siblings; updates in-place content for shared ids;
 * appends new ids as a chain from the common prefix.
 */
export function syncActivePath(
  t: BranchableTranscript,
  path: UIMessage[],
): BranchableTranscript {
  if (path.length === 0) {
    return { ...t, headId: null };
  }

  const oldPath = activePath(t);
  let common = 0;
  while (
    common < oldPath.length &&
    common < path.length &&
    oldPath[common]!.id === path[common]!.id
  ) {
    common++;
  }

  const messages = t.messages.map((n) => ({ ...n, message: { ...n.message } }));
  const indexById = new Map(messages.map((n, i) => [n.message.id, i]));

  for (const message of path) {
    const idx = indexById.get(message.id);
    if (idx != null) {
      messages[idx] = {
        parentId: messages[idx]!.parentId,
        message: { ...message },
      };
    }
  }

  for (let i = common; i < path.length; i++) {
    const message = path[i]!;
    if (indexById.has(message.id)) {
      const idx = indexById.get(message.id)!;
      messages[idx] = {
        parentId: i === 0 ? null : path[i - 1]!.id,
        message: { ...message },
      };
      continue;
    }
    messages.push({
      parentId: i === 0 ? null : path[i - 1]!.id,
      message: { ...message },
    });
    indexById.set(message.id, messages.length - 1);
  }

  return {
    version: 1,
    headId: path[path.length - 1]!.id,
    messages,
  };
}
