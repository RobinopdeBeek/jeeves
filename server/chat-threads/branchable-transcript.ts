import type { UIMessage } from "ai";
import type {
  BranchableTranscript,
  BranchNode,
} from "../../shared/branchable-transcript.js";

export type { BranchableTranscript, BranchNode } from "../../shared/branchable-transcript.js";

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

/**
 * Accept on-disk JSON: legacy flat `UIMessage[]` or v1 branchable object.
 * Corrupt / unknown shapes become an empty transcript.
 */
export function parseTranscriptFile(raw: unknown): BranchableTranscript {
  if (Array.isArray(raw)) {
    return fromLinear(raw as UIMessage[]);
  }
  if (
    raw &&
    typeof raw === "object" &&
    (raw as BranchableTranscript).version === 1 &&
    Array.isArray((raw as BranchableTranscript).messages)
  ) {
    const t = raw as BranchableTranscript;
    return {
      version: 1,
      headId: t.headId ?? null,
      messages: t.messages,
    };
  }
  return emptyTranscript();
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

  const byId = nodeMap(t);
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

  // Refresh content for messages still on the shared prefix / updated path ids.
  for (const message of path) {
    const idx = indexById.get(message.id);
    if (idx != null) {
      messages[idx] = {
        parentId: messages[idx]!.parentId,
        message: { ...message },
      };
    }
  }

  // Link new messages after the common prefix.
  for (let i = common; i < path.length; i++) {
    const message = path[i]!;
    if (indexById.has(message.id)) {
      // Id already exists off-path or was updated above — relink onto this path.
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
