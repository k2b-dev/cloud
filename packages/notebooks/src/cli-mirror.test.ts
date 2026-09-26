import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CloudCliContext } from "@k2b/cloud/cli";
import {
  findManifestFolder,
  findManifestNote,
  findMirror,
  MANIFEST_FILE,
  type Manifest,
  mirrorFileContent,
  mirrorLayout,
  newManifest,
  readManifest,
  renderMirrorFile,
  restoreAttachmentLinks,
  restoreNoteLinks,
  rewriteAttachmentLinks,
  rewriteNoteLinks,
  type SyncReport,
  stripFrontMatter,
  syncMirror,
  writeManifest,
} from "./cli-mirror";
import { noteContentHash } from "./lib/note-edit";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const attachments = new Map([["att001", { id: "att001", filename: "Plan (final) ä.png" }]]);
const notePaths = new Map([
  ["note01", "betrieb/backup.md"],
  ["note02", "betrieb/index.md"],
  ["note03", "start.md"],
]);

describe("mirror file format", () => {
  test("round-trips server content through front matter and relative attachment links", () => {
    const content = "# Backup\n\n![Plan](attach://att001) and [missing](attach://gone01)\n";
    const text = renderMirrorFile(
      { id: "note01", title: 'Backup "neu"', updatedAt: "2026-09-25T10:00:00.000Z" },
      content,
      "betrieb/backup.md",
      attachments,
      new Map(),
    );
    expect(text).toBe(
      '---\nid: note01\ntitle: "Backup \\"neu\\""\nupdatedAt: 2026-09-25T10:00:00.000Z\n---\n# Backup\n\n![Plan](../_attachments/att001-Plan-final-a.png) and [missing](attach://gone01)\n',
    );
    expect(mirrorFileContent(text, "betrieb/backup.md", new Map())).toBe(content);
  });

  test("round-trips note links as relative mirror paths", () => {
    const content =
      '# Backup\n\n[Start](note://note03) [Betrieb](note://note02#ziel) [Selbst](note://note01 "t") [Fremd](note://other1) note://note03\n';
    const text = renderMirrorFile({ id: "note01", title: "Backup", updatedAt: "x" }, content, "betrieb/backup.md", new Map(), notePaths);
    expect(text).toEndWith('[Start](../start.md) [Betrieb](index.md#ziel) [Selbst](backup.md "t") [Fremd](note://other1) note://note03\n');
    expect(mirrorFileContent(text, "betrieb/backup.md", notePaths)).toBe(content);
  });

  test("restores only relative links that name a mirror note from the file's own folder", () => {
    expect(rewriteNoteLinks("[a](note://note01)", "start.md", notePaths)).toBe("[a](betrieb/backup.md)");
    expect(
      restoreNoteLinks("[a](betrieb/backup.md) [b](backup.md) [c](../start.md) [d](https://x.org/start.md)", "start.md", notePaths),
    ).toBe("[a](note://note01) [b](backup.md) [c](../start.md) [d](https://x.org/start.md)");
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

type ServerNote = { id: string; parentId: string | null; title: string; content: string; updatedAt: string };

/** An in-memory notebook behind the endpoints that pull reads, and a mirror folder for it. */
const mirrorOf = async (notes: ServerNote[]) => {
  const root = await mkdtemp(join(tmpdir(), "nb-sync-"));
  dirs.push(root);
  await writeManifest(root, newManifest("http://cloud.test", { id: "nb0001", name: "Docs" }));
  const downloads: string[] = [];
  const ctx: CloudCliContext = {
    args: [],
    flags: {},
    options: { profile: "test", server: "http://cloud.test", token: "token", output: "text" },
    getDefault: async () => undefined,
    setDefault: async () => undefined,
    createApiClient: (() => {
      throw new Error("not needed");
    }) as CloudCliContext["createApiClient"],
    fetch: async (path) => {
      const url = new URL(path, "http://cloud.test");
      if (url.pathname.endsWith("/outline"))
        return Response.json({
          data: notes.map(({ content: _content, ...note }) => ({
            ...note,
            hasChildren: notes.some((child) => child.parentId === note.id),
          })),
          pagination: { has_next: false },
        });
      if (url.pathname.endsWith("/attachments")) return Response.json([]);
      const note = notes.find((candidate) => url.pathname.endsWith(`/notes/${candidate.id}/content`));
      if (!note) return new Response("not found", { status: 404 });
      downloads.push(note.id);
      return Response.json({ id: note.id, title: note.title, updatedAt: note.updatedAt, contentMd: note.content });
    },
    readJson: async (response) => response.json(),
    print: () => undefined,
    write: async () => undefined,
    error: () => undefined,
    json: () => undefined,
    jsonLine: () => undefined,
    table: () => undefined,
  };
  const note = (id: string) => notes.find((candidate) => candidate.id === id)!;
  return {
    root,
    notes,
    downloads,
    /** Change a note on the server like an editor save. */
    save: (id: string, change: Partial<ServerNote>) => Object.assign(note(id), change, { updatedAt: `${note(id).updatedAt}+` }),
    pull: async (options: { refetch?: string[] } = {}) => {
      downloads.splice(0);
      const manifest = await readManifest(root);
      return (await syncMirror(ctx, { root, manifest, force: false, refetch: new Set(options.refetch) })).report;
    },
    read: (path: string) => readFile(join(root, path), "utf8"),
    put: async (path: string, text: string) => {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    },
    manifest: () => readManifest(root),
  };
};

const serverNote = (id: string, title: string, body = "", parentId: string | null = null): ServerNote => ({
  id,
  parentId,
  title,
  content: `# ${title}\n${body}`,
  updatedAt: "2026-09-26T10:00:00.000Z",
});

/** A folder note that already has a child, so moving notes into it changes no other path. */
const folder = [serverNote("dir001", "Ordner"), serverNote("kid001", "Kind", "", "dir001")];

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

describe("pull", () => {
  test("a renamed note that was just written moves, and files linking to it follow and stay clean", async () => {
    const mirror = await mirrorOf([serverNote("start1", "Start", "\n[B](note://bbbbbb#x)\n"), serverNote("bbbbbb", "B")]);
    await mirror.pull();
    expect(await mirror.read("start.md")).toEndWith("[B](b.md#x)\n");

    // `write` uploaded a new heading; the refresh refetches that note even though its file differs locally.
    await mirror.put("b.md", (await mirror.read("b.md")).replace("# B", "# Neu"));
    mirror.save("bbbbbb", { title: "Neu", content: "# Neu\n" });
    const report = await mirror.pull({ refetch: ["bbbbbb"] });
    expect(report).toMatchObject({ written: ["start.md", "neu.md"], removed: ["b.md"], kept: [] });
    expect(await mirror.read("start.md")).toEndWith("[B](neu.md#x)\n");
    expect(await mirror.pull()).toMatchObject({ written: [], removed: [], kept: [] });
  });

  test("server content with a literal relative link to a mirror file stays clean across pulls", async () => {
    const mirror = await mirrorOf([serverNote("start1", "Start", "\n[B](b.md)\n"), serverNote("bbbbbb", "B"), ...folder]);
    await mirror.pull();
    const start = await mirror.read("start.md");
    expect(start).toEndWith("[B](b.md)\n");
    expect(await mirror.pull()).toMatchObject({ written: [], kept: [] });
    expect(mirror.downloads).toEqual([]);

    // When b.md moves, the file is checked against the server once; the literal link stays literal.
    mirror.save("bbbbbb", { parentId: "dir001" });
    const report = await mirror.pull();
    expect(report).toMatchObject({ written: ["ordner/b.md"], removed: ["b.md"], kept: [] });
    expect(mirror.downloads.sort()).toEqual(["bbbbbb", "start1"]);
    expect(await mirror.read("start.md")).toBe(start);
    expect(await mirror.pull()).toMatchObject({ written: [], kept: [] });
    expect(mirror.downloads).toEqual([]);
  });

  test("links to notes that are kept or cannot be placed point to their actual files and stay clean", async () => {
    const mirror = await mirrorOf([
      serverNote("start1", "Start", "\n[B](note://bbbbbb) [C](note://cccccc) [E](note://eeeeee)\n"),
      serverNote("bbbbbb", "B"),
      serverNote("cccccc", "C"),
    ]);
    await mirror.pull();
    const start = await mirror.read("start.md");
    expect(start).toEndWith("[B](b.md) [C](c.md) [E](note://eeeeee)\n");

    await mirror.put("b.md", `${await mirror.read("b.md")}local\n`);
    mirror.save("bbbbbb", { title: "B2", content: "# B2\n" });
    await mirror.put("d.md", "unrelated\n");
    mirror.save("cccccc", { title: "D", content: "# D\n" });
    await mirror.put("e.md", "unrelated\n");
    mirror.save("start1", {});
    mirror.notes.push(serverNote("eeeeee", "E"));
    const kept: SyncReport["kept"] = [
      { path: "b.md", reason: "changed-on-both-sides" },
      { path: "c.md", reason: "path-occupied" },
      { path: "e.md", reason: "path-occupied" },
    ];
    expect((await mirror.pull()).kept).toEqual(kept);
    expect(await mirror.read("start.md")).toEndWith("[B](b.md) [C](c.md) [E](note://eeeeee)\n");
    expect(await mirror.read("c.md")).toContain("# D\n");
    expect(await mirror.read("d.md")).toBe("unrelated\n");
    expect(await mirror.pull()).toMatchObject({ written: [], kept });
  });

  test("a move onto an occupied path keeps the note's file and entry, which can block the next move", async () => {
    const mirror = await mirrorOf([serverNote("xxxxxx", "X"), serverNote("zzzzzz", "Z"), ...folder]);
    await mirror.pull();
    const before = await mirror.manifest();
    const edited = `${await mirror.read("x.md")}local\n`;
    await mirror.put("x.md", edited);
    await mirror.put("ordner/x.md", "unrelated\n");
    // X moves into ordner/, where a local file is in the way; Z is renamed onto the x.md that X would free.
    mirror.save("xxxxxx", { parentId: "dir001" });
    mirror.save("zzzzzz", { title: "X", content: "# X\n" });

    const report = await mirror.pull();
    expect(report).toMatchObject({
      removed: [],
      kept: [
        { path: "x.md", reason: "path-occupied" },
        { path: "z.md", reason: "path-occupied" },
      ],
    });
    expect(await mirror.read("x.md")).toBe(edited);
    expect(await mirror.read("ordner/x.md")).toBe("unrelated\n");
    expect(await mirror.read("z.md")).toContain("# X\n");
    const after = await mirror.manifest();
    expect(after.notes.find((note) => note.id === "xxxxxx")).toEqual({
      ...before.notes.find((note) => note.id === "xxxxxx")!,
      updatedAt: "2026-09-26T10:00:00.000Z+",
    });
    expect(after.notes.find((note) => note.id === "zzzzzz")?.path).toBe("z.md");
  });

  test("never rewrites a locally modified file whose note stays, even when a linked note moves", async () => {
    const mirror = await mirrorOf([serverNote("start1", "Start", "\n[B](note://bbbbbb)\n"), serverNote("bbbbbb", "B"), ...folder]);
    await mirror.pull();
    // Restoring and rendering this file again would change it: the literal self link and the link to b.md.
    const edited = `${await mirror.read("start.md")}[Self](start.md) local\n`;
    await mirror.put("start.md", edited);
    mirror.save("bbbbbb", { parentId: "dir001" });

    const report = await mirror.pull();
    expect(report).toMatchObject({ written: ["ordner/b.md"], removed: ["b.md"], kept: [{ path: "start.md", reason: "local-changes" }] });
    expect(await mirror.read("start.md")).toBe(edited);
  });

  test("a locally modified file whose note moves carries its edits and updates its relative links", async () => {
    const mirror = await mirrorOf([serverNote("start1", "Start", "\n[B](note://bbbbbb)\n"), serverNote("bbbbbb", "B"), ...folder]);
    await mirror.pull();
    await mirror.put("start.md", `${await mirror.read("start.md")}local\n`);
    mirror.save("start1", { parentId: "dir001" });

    const report = await mirror.pull();
    expect(report).toMatchObject({
      written: ["ordner/start.md"],
      removed: ["start.md"],
      kept: [{ path: "ordner/start.md", reason: "local-changes" }],
    });
    expect(await mirror.read("ordner/start.md")).toEndWith("[B](../b.md)\nlocal\n");
    expect(await exists(join(mirror.root, "start.md"))).toBe(false);
  });

  test("a manifest without file hashes keeps working and gains them as files are rendered again", async () => {
    const notes = [
      serverNote("start1", "Start", "\n[B](note://bbbbbb)\n"),
      serverNote("bbbbbb", "B", "\n![Plan](attach://att001)\n"),
      serverNote("cccccc", "C"),
    ];
    const mirror = await mirrorOf(notes);
    // What the previous version wrote: note links stay note:// links, and no fileHash.
    const old = (note: ServerNote) => `---\nid: ${note.id}\ntitle: "${note.title}"\nupdatedAt: ${note.updatedAt}\n---\n${note.content}`;
    for (const note of notes) await mirror.put(`${note.title.toLowerCase()}.md`, old(note));
    await mirror.put("c.md", `${old(notes[2]!)}local\n`);
    await writeManifest(mirror.root, {
      ...(await mirror.manifest()),
      notes: notes.map((note) => ({
        id: note.id,
        path: `${note.title.toLowerCase()}.md`,
        contentHash: noteContentHash(note.content),
        updatedAt: note.updatedAt,
      })),
    });

    const report = await mirror.pull();
    expect(report).toMatchObject({ written: ["start.md"], kept: [{ path: "c.md", reason: "local-changes" }] });
    expect(await mirror.read("start.md")).toEndWith("[B](b.md)\n");
    expect((await mirror.manifest()).notes.map((note) => [note.path, note.fileHash !== undefined])).toEqual([
      ["b.md", false],
      ["c.md", false],
      ["start.md", true],
    ]);
    expect(await mirror.pull()).toMatchObject({ written: [], kept: [{ path: "c.md", reason: "local-changes" }] });
  });
});
