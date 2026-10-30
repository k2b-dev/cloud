import { files } from "@k2b/stdlib/browser";
import { mockupNotes } from "../test/fixtures/mockup-notes";

const help = `Usage: bun scripts/fixture-export.ts <out.zip> [--now <epoch ms>]

Writes the fictional notes of mockup v4 as an export ZIP (with links), ready for the import dialog.
Use it for screenshots and manual checks; the data is invented.`;
const out = process.argv[2];
if (!out || out === "--help") {
  console.log(help);
  process.exit(out ? 0 : 1);
}
const nowFlag = process.argv.indexOf("--now");
const now = nowFlag > 0 ? Number(process.argv[nowFlag + 1]) : Date.now();
const notes = mockupNotes(now);
const manifest = {
  version: 1,
  app: "k2b-notes",
  exportedAt: new Date(now).toISOString(),
  notes: notes.map((note) => ({
    id: note.id,
    title: note.text.split("\n")[0]?.replace(/^#\s*/, "") ?? "",
    tags: [],
    createdAt: note.updatedAt,
    updatedAt: note.updatedAt,
    file: `notes/${note.id}.md`,
    files: [],
    ...(note.share ? { share: note.share } : {}),
  })),
};
const zip = await files.createZip([
  { filename: "manifest.json", source: JSON.stringify(manifest, null, 2) },
  ...notes.map((note) => ({ filename: `notes/${note.id}.md`, source: note.text })),
]);
await Bun.write(out, zip);
console.log(`${notes.length} notes → ${out}`);
