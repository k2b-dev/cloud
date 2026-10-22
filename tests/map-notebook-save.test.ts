import { expect, test } from "bun:test";
import { saveMapNotebook } from "../packages/cloud/src/ai/map-notebook-save";
import { applyNoteEdits, noteContentHash } from "../packages/notebooks/src/lib/note-edit";

test("the save helper composes the public schemas with actual Notebook edit semantics", async () => {
  const { NoteCreateInputSchema, NoteEditInputSchema, NoteReadInputSchema } = await import(
    "../packages/notebooks/src/capability-contracts"
  );
  const content = `# Trip\n\n:::geo\n${JSON.stringify({ polyline6: "\\\\😀".repeat(90_000) })}\n:::\n`;
  let stored = "";
  let calls = 0;
  const result = await saveMapNotebook({
    content,
    notebookId: "book01",
    sourceKey: "map:revision:1",
    onCheckpoint: () => {},
    client: {
      fetch: async (url, request) => {
        const { input } = JSON.parse(String(request?.body));
        if (String(url).endsWith("note.create")) {
          stored = NoteCreateInputSchema.parse(input).content ?? "";
          return Response.json({ data: { id: "note01", notebookId: "book01" } });
        }
        if (String(url).endsWith("note.read")) {
          expect(NoteReadInputSchema.parse(input).contentLimit).toBe(1);
          return Response.json({ data: { id: "note01", notebookId: "book01", contentHash: noteContentHash(stored) } });
        }
        const edit = NoteEditInputSchema.parse(input);
        const applied = applyNoteEdits(stored, edit.operations, edit);
        stored = applied.content;
        calls++;
        return Response.json({ data: { beforeHash: applied.beforeHash, afterHash: applied.afterHash } });
      },
    },
  });
  expect(result.status).toBe("saved");
  expect(calls).toBeGreaterThan(1);
  expect(stored).toBe(content);
  expect(noteContentHash(stored)).toBe(noteContentHash(content));
});
