import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardStore } from "../cards/store.js";
import { openDb, type Db } from "../db/index.js";
import type { Project } from "../db/schema.js";
import {
  CardAttachmentStore,
  CardAttachmentStoreError,
} from "./card-library.js";
import { cardLibraryAttachmentsDir } from "./store.js";

describe("CardAttachmentStore", () => {
  let db: Db;
  let cards: CardStore;
  let project: Project;
  let artifactRoot: string;
  let store: CardAttachmentStore;
  let cardId: string;

  beforeEach(() => {
    db = openDb(":memory:");
    cards = new CardStore(db);
    project = cards.ensureDefaultProject("jeeves", "C:/repo");
    artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-card-att-"));
    store = new CardAttachmentStore(db, artifactRoot);
    cardId = cards.createCard(project.id).id;
  });

  afterEach(() => {
    fs.rmSync(artifactRoot, { recursive: true, force: true });
  });

  it("adds, lists, patches instruction, and deletes", () => {
    const created = store.add({
      cardId,
      filename: "notes.md",
      mediaType: "text/markdown",
      bytes: Buffer.from("# hi\n", "utf8"),
      instruction: "Use as context",
      originStep: "info",
    });

    expect(created.filename).toBe("notes.md");
    expect(created.instruction).toBe("Use as context");
    expect(created.originStep).toBe("info");
    expect(created.path).toBe(
      `cards/${cardId}/attachments/${created.id}-notes.md`,
    );
    expect(
      fs.existsSync(path.join(artifactRoot, created.path.replace(/\//g, path.sep))),
    ).toBe(true);

    expect(store.list(cardId)).toEqual([created]);

    const patched = store.updateInstruction(cardId, created.id, "Revised");
    expect(patched?.instruction).toBe("Revised");
    expect(store.get(cardId, created.id)?.instruction).toBe("Revised");

    expect(store.delete(cardId, created.id)).toBe(true);
    expect(store.list(cardId)).toEqual([]);
    expect(
      fs.existsSync(path.join(artifactRoot, created.path.replace(/\//g, path.sep))),
    ).toBe(false);
  });

  it("defaults originStep to info and rejects empty bytes", () => {
    const created = store.add({
      cardId,
      filename: "a.txt",
      bytes: Buffer.from("x"),
    });
    expect(created.originStep).toBe("info");

    expect(() =>
      store.add({ cardId, filename: "empty.txt", bytes: Buffer.alloc(0) }),
    ).toThrow(CardAttachmentStoreError);
  });

  it("resolves absolutePath and contentType for on-disk bytes", () => {
    const created = store.add({
      cardId,
      filename: "notes.md",
      mediaType: "text/markdown",
      bytes: Buffer.from("# hi\n", "utf8"),
    });
    const abs = store.absolutePath(cardId, created.id);
    expect(abs).toBeTruthy();
    expect(fs.readFileSync(abs!, "utf8")).toBe("# hi\n");
    expect(store.contentType(cardId, created.id)).toMatch(/markdown|plain/);
  });

  it("writes under cards/<cardId>/attachments/", () => {
    const created = store.add({
      cardId,
      filename: "notes.md",
      mediaType: "text/markdown",
      bytes: Buffer.from("# notes\n", "utf8"),
    });
    const dir = cardLibraryAttachmentsDir(artifactRoot, cardId);
    expect(fs.existsSync(dir)).toBe(true);
    expect(
      fs.readdirSync(dir).some((n) => n === `${created.id}-notes.md`),
    ).toBe(true);
  });

  it("rejects unsupported types like PDF", () => {
    expect(() =>
      store.add({
        cardId,
        filename: "ref.pdf",
        mediaType: "application/pdf",
        bytes: Buffer.from("%PDF"),
      }),
    ).toThrow(/Unsupported attachment type/);
  });
});
