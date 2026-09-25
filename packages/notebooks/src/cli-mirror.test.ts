import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findManifestFolder,
  findManifestNote,
  findMirror,
  MANIFEST_FILE,
  type Manifest,
  mirrorFileContent,
  mirrorLayout,
  renderMirrorFile,
  restoreAttachmentLinks,
  rewriteAttachmentLinks,
  stripFrontMatter,
} from "./cli-mirror";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const attachments = new Map([["att001", { id: "att001", filename: "Plan (final) ä.png" }]]);

describe("mirror file format", () => {
  test("round-trips server content through front matter and relative attachment links", () => {
    const content = "# Backup\n\n![Plan](attach://att001) and [missing](attach://gone01)\n";
    const text = renderMirrorFile(
      { id: "note01", title: 'Backup "neu"', updatedAt: "2026-09-25T10:00:00.000Z" },
      content,
      "betrieb/backup.md",
      attachments,
    );
    expect(text).toBe(
      '---\nid: note01\ntitle: "Backup \\"neu\\""\nupdatedAt: 2026-09-25T10:00:00.000Z\n---\n# Backup\n\n![Plan](../_attachments/att001-Plan-final-a.png) and [missing](attach://gone01)\n',
    );
    expect(mirrorFileContent(text, "betrieb/backup.md")).toBe(content);
  });

  test("restores only links written for the file's own depth", () => {
    expect(rewriteAttachmentLinks("attach://att001", 0, attachments)).toBe("_attachments/att001-Plan-final-a.png");
    expect(restoreAttachmentLinks("_attachments/att001-x.png ../_attachments/att001-x.png", 0)).toBe(
      "attach://att001 ../_attachments/att001-x.png",
    );
    expect(restoreAttachmentLinks("../../_attachments/att001-x.png", 1)).toBe("../../_attachments/att001-x.png");
  });

  test("keeps foreign front matter as content", () => {
    expect(stripFrontMatter("---\ntitle: Doc\n---\n# Doc\n")).toBe("---\ntitle: Doc\n---\n# Doc\n");
    expect(stripFrontMatter('---\nid: abc123\ntitle: "Doc"\nupdatedAt: x\n---\n# Doc\n')).toBe("# Doc\n");
  });
});

describe("mirror layout", () => {
  test("leaf notes are files, notes with children are folders with index.md", () => {
    const layout = mirrorLayout([
      { id: "root01", parentId: null, title: "Betrieb", hasChildren: true, updatedAt: "" },
      { id: "dup001", parentId: "root01", title: "Backup", hasChildren: false, updatedAt: "" },
      { id: "dup002", parentId: "root01", title: "Backup", hasChildren: true, updatedAt: "" },
      { id: "kid001", parentId: "dup002", title: "Restore", hasChildren: false, updatedAt: "" },
    ]);
    expect(Object.fromEntries(layout)).toEqual({
      root01: "betrieb/index.md",
      dup001: "betrieb/backup--dup001.md",
      dup002: "betrieb/backup--dup002/index.md",
      kid001: "betrieb/backup--dup002/restore.md",
    });
  });

  test("maps mirror files and folders to manifest notes", () => {
    const manifest: Manifest = {
      version: 1,
      server: "http://cloud.test",
      notebook: { id: "nb0001", name: "Docs" },
      notes: [
        { id: "root01", path: "betrieb/index.md", contentHash: "h", updatedAt: "" },
        { id: "leaf01", path: "betrieb/backup.md", contentHash: "h", updatedAt: "" },
      ],
    };
    expect(findManifestNote(manifest, "betrieb")?.id).toBe("root01");
    expect(findManifestNote(manifest, "betrieb/")?.id).toBe("root01");
    expect(findManifestNote(manifest, "betrieb/index.md")?.id).toBe("root01");
    expect(findManifestNote(manifest, "betrieb/backup.md")?.id).toBe("leaf01");
    expect(findManifestNote(manifest, "betrieb/neu.md")).toBeNull();
    expect(findManifestFolder(manifest, "betrieb/backup")?.id).toBe("leaf01");
  });

  test("finds the mirror root from a file that does not exist yet", async () => {
    const root = await mkdtemp(join(tmpdir(), "nb-mirror-"));
    dirs.push(root);
    await writeFile(join(root, MANIFEST_FILE), "{}");
    await mkdir(join(root, "betrieb"));
    expect(await findMirror(join(root, "betrieb/neu/datei.md"))).toEqual({ root, relPath: "betrieb/neu/datei.md" });
    expect(await findMirror(root)).toEqual({ root, relPath: "" });
    expect(await findMirror(tmpdir())).toBeNull();
  });
});
