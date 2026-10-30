import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { files } from "@k2b/stdlib/browser";
import { MemoryBackend, type NotesStore, openNotesStore } from "./local";
import { MAX_IMPORT_BYTES } from "./model";
import { applyImport, type ExportManifest, exportAll, ImportError, readImport } from "./transfer";

const NOW = 1793318400000;
const date = new Date(NOW);
beforeAll(() => setSystemTime(date));
afterAll(() => setSystemTime());
const makeStore = () => openNotesStore({ backend: new MemoryBackend(), now: () => NOW, locks: null });
async function exported(store: NotesStore, includeLinks = false) {
  const result = await exportAll(store, { includeLinks, now: date });
  return new File([result.blob], result.filename, { lastModified: NOW });
}
async function archive(entries: { filename: string; source: string }[]) {
  return new File([new Uint8Array(await files.createZip(entries, { compressionLevel: 0 }))], "import.zip", { lastModified: NOW });
}
test("ZIP roundtrip includes manifest, markdown, files, timestamps; links are opt-in and imported as local copies", async () => {
  const source = await makeStore();
  const target = await makeStore();
  try {
    const id = await source.create("# Äpfel\n#garten", { share: { kind: "own", readId: "read", editId: "edit", sharedAt: NOW } });
    const key = await source.putFile(id, new Blob(["image"], { type: "image/png" }), "Bild.png");
    const note = await source.open(id);
    note.text.insert(note.text.length, `\n![Bild](file:${key})`);
    await note.close();
    const zip = await exported(source);
    expect(zip.name).toBe("notes-2026-10-30.zip");
    const extracted = await files.extractZip(new Uint8Array(await zip.arrayBuffer()));
    const manifest = extracted.find((entry) => entry.filename === "manifest.json");
    expect(new TextDecoder().decode(manifest?.data)).not.toContain('"share"');
    const markdown = extracted.find((entry) => entry.filename.endsWith(".md"));
    expect(new TextDecoder().decode(markdown?.data)).toContain(`../files/${id}/${key}.png`);
    const withLinks = await files.extractZip(new Uint8Array(await (await exported(source, true)).arrayBuffer()));
    expect(new TextDecoder().decode(withLinks.find((entry) => entry.filename === "manifest.json")?.data)).toContain('"share"');
    const preview = await readImport([zip], target);
    expect(preview.notes).toBe(1);
    expect(preview.images).toBe(1);
    expect(preview.duplicates).toEqual([]);
    expect(await applyImport(preview, target, "skip")).toEqual({ imported: 1, skipped: 0 });
    expect(target.records()[0]?.id).toBe(id);
    expect(target.records()[0]?.share).toBeNull();
    expect(target.records()[0]?.createdAt).toBe(NOW);
    expect((await target.open(id)).text.toString()).toContain(`file:${key}`);
    expect(await (await target.getFile(id, key))?.text()).toBe("image");
  } finally {
    await source.close();
    await target.close();
  }
});
test("duplicate modes skip, replace and both; shared local duplicates cannot be replaced", async () => {
  const source = await makeStore();
  const target = await makeStore();
  try {
    const id = await source.create("# Imported");
    const zip = await exported(source);
    await target.create("# Existing", { id });
    const preview = await readImport([zip], target);
    expect(preview.duplicates).toEqual([id]);
    expect(await applyImport(preview, target, "skip")).toEqual({ imported: 0, skipped: 1 });
    expect((await target.open(id)).text.toString()).toBe("# Existing");
    expect(await applyImport(preview, target, "replace")).toEqual({ imported: 1, skipped: 0 });
    expect((await target.open(id)).text.toString()).toBe("# Imported");
    expect(await applyImport(preview, target, "both")).toEqual({ imported: 1, skipped: 0 });
    expect(target.records()).toHaveLength(2);
    const copy = target.records().find((record) => record.id !== id);
    expect(copy?.share).toBeNull();
    await target.update(id, { share: { kind: "own", readId: "r", editId: "e", sharedAt: NOW } });
    expect(await applyImport(preview, target, "replace")).toEqual({ imported: 0, skipped: 1 });
  } finally {
    await source.close();
    await target.close();
  }
});
test("standalone Markdown and invalid files", async () => {
  const store = await makeStore();
  try {
    const preview = await readImport([new File(["# Markdown"], "notes.md", { lastModified: NOW })], store);
    expect(preview.notes).toBe(1);
    expect(preview.entries[0]?.updatedAt).toBe(NOW);
    await applyImport(preview, store, "skip");
    expect(store.records()[0]?.meta.title).toBe("Markdown");
    await expect(readImport([new File(["no"], "x.zip")], store)).rejects.toMatchObject({ code: "invalid" });
    await expect(readImport([new File(["no"], "x.txt")], store)).rejects.toBeInstanceOf(ImportError);
  } finally {
    await store.close();
  }
});
test("rejects unsafe archive paths, including directory entries, before extraction", async () => {
  const store = await makeStore();
  try {
    const good = await archive([{ filename: "xxx/a.md", source: "hello" }]);
    for (const path of ["../a.md", "/xx/a.md", "xxx\\a.md"]) {
      const bytes = new Uint8Array(await good.arrayBuffer());
      const old = new TextEncoder().encode("xxx/a.md");
      const replacement = new TextEncoder().encode(path.padEnd(old.length, "x"));
      for (let i = 0; i <= bytes.length - old.length; i++) if (old.every((byte, j) => bytes[i + j] === byte)) bytes.set(replacement, i);
      await expect(readImport([new File([bytes], "bad.zip")], store)).rejects.toMatchObject({ code: "unsafe_path" });
    }
    await expect(readImport([new File(["x"], "../bad.md")], store)).rejects.toMatchObject({ code: "unsafe_path" });
  } finally {
    await store.close();
  }
});
test("limits archive entries, declared expanded size and aggregate Markdown input", async () => {
  const store = await makeStore();
  try {
    const tooMany = await archive(Array.from({ length: 1001 }, (_, i) => ({ filename: `${i}.md`, source: "" })));
    await expect(readImport([tooMany], store)).rejects.toMatchObject({ code: "too_many" });
    const zip = new Uint8Array(await (await archive([{ filename: "x.md", source: "a" }])).arrayBuffer());
    const view = new DataView(zip.buffer);
    for (let i = 0; i < zip.length - 46; i++)
      if (view.getUint32(i, true) === 0x02014b50) {
        view.setUint32(i + 24, MAX_IMPORT_BYTES + 1, true);
        break;
      }
    await expect(readImport([new File([zip], "large.zip")], store)).rejects.toMatchObject({ code: "too_large" });
    const large = new File(["x"], "large.md");
    Object.defineProperty(large, "size", { value: MAX_IMPORT_BYTES + 1 });
    await expect(readImport([large], store)).rejects.toMatchObject({ code: "too_large" });
  } finally {
    await store.close();
  }
});

test("replace removes obsolete attachments and keeps the existing open document", async () => {
  const source = await makeStore();
  const target = await makeStore();
  try {
    const id = await source.create("# New");
    const preview = await readImport([await exported(source)], target);
    await target.create("# Old", { id });
    const key = await target.putFile(id, new Blob(["old"]), "old.png");
    const opened = await target.open(id);
    await applyImport(preview, target, "replace");
    expect(opened.text.toString()).toBe("# New");
    expect(await target.getFile(id, key)).toBeNull();
    expect(await target.listFiles(id)).toEqual([]);
  } finally {
    await source.close();
    await target.close();
  }
});
test("rejects false decompressed sizes and corrupted ZIP checksums", async () => {
  const store = await makeStore();
  try {
    const zip = new Uint8Array(await files.createZip([{ filename: "manifest.json", source: "a".repeat(100000) }]));
    const view = new DataView(zip.buffer);
    for (let i = 0; i < zip.length - 46; i++)
      if (view.getUint32(i, true) === 0x02014b50) {
        view.setUint32(i + 24, 1, true);
        break;
      }
    await expect(readImport([new File([zip], "lie.zip", { lastModified: NOW })], store)).rejects.toMatchObject({ code: "invalid" });
    const corrupted = new Uint8Array(await (await archive([{ filename: "x.md", source: "original" }])).arrayBuffer());
    corrupted[34] = (corrupted[34] ?? 0) ^ 1;
    await expect(readImport([new File([corrupted], "corrupt.zip", { lastModified: NOW })], store)).rejects.toMatchObject({
      code: "invalid",
    });
  } finally {
    await store.close();
  }
});

test("manifest paths cannot be reused to multiply imported notes or files", async () => {
  const store = await makeStore();
  try {
    const key = "K".repeat(22);
    const make = (id: string, file: string): ExportManifest["notes"][number] => ({
      id,
      title: "N",
      tags: [],
      createdAt: NOW,
      updatedAt: NOW,
      file,
      files: [],
    });
    const first = make("A".repeat(22), "notes/a.md");
    const second = make("B".repeat(22), "notes/a.md");
    const manifest = { version: 1, app: "k2b-notes", exportedAt: date.toISOString(), notes: [first, second] };
    const makeZip = () =>
      archive([
        { filename: "manifest.json", source: JSON.stringify(manifest) },
        { filename: "notes/a.md", source: "# A" },
        { filename: "notes/b.md", source: "# B" },
        { filename: "files/x.png", source: "image" },
      ]);
    await expect(readImport([await makeZip()], store)).rejects.toMatchObject({ code: "invalid" });
    second.file = "notes/b.md";
    first.files = [{ key, name: "x.png", path: "files/x.png", type: "image/png" }];
    second.files = [...first.files];
    await expect(readImport([await makeZip()], store)).rejects.toMatchObject({ code: "invalid" });
    manifest.notes = Array.from({ length: 1001 }, () => first);
    await expect(readImport([await makeZip()], store)).rejects.toMatchObject({ code: "too_many" });
  } finally {
    await store.close();
  }
});
test("an export with links brings the links back, but never onto a second copy", async () => {
  const source = await makeStore();
  const target = await makeStore();
  try {
    const share = { kind: "own" as const, readId: "R".repeat(22), editId: "E".repeat(22), sharedAt: NOW };
    const id = await source.create("# Geteilt", { share });
    const preview = await readImport([await exported(source, true)], target);
    await applyImport(preview, target, "skip");
    expect(target.records()[0]?.share).toEqual(share);
    // Same Yjs identity: syncing the original state into the imported note changes nothing, so no text doubles.
    await target.applyUpdate(id, await source.encodeState(id));
    expect((await target.open(id)).text.toString()).toBe("# Geteilt");
    await applyImport(await readImport([await exported(source, true)], target), target, "both");
    expect(
      target
        .records()
        .filter((record) => record.id !== id)
        .map((record) => record.share),
    ).toEqual([null]);
  } finally {
    await source.close();
    await target.close();
  }
});
