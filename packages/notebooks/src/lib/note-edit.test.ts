import { describe, expect, test } from "bun:test";
import { applyNoteEdits, NoteEditError, noteContentHash, summarizeNoteEditBlocks } from "./note-edit";

const source = `# Note

Intro

@ideas
| Idea | Status |
|---|---|
| CLI | open |

@tasks
- [ ] first
- [ ] second

@log
## Log
Old entry
`;

describe("note edit", () => {
  test("replaces 1-based line ranges", () => {
    const result = applyNoteEdits(source, [{ kind: "replace-lines", startLine: 3, endLine: 3, content: "Updated intro" }]);
    expect(result.content).toContain("Updated intro\n\n@ideas");
    expect(result.content).not.toContain("\nIntro\n");
  });

  test("inserts after a 1-based line", () => {
    const result = applyNoteEdits("# A\nB", [{ kind: "insert-after-line", line: 1, content: "middle" }]);
    expect(result.content).toBe("# A\nmiddle\nB");
  });

  test("replaces a named block body while preserving the handle", () => {
    const result = applyNoteEdits(source, [
      {
        kind: "replace-block",
        name: "ideas",
        type: "table",
        content: "| Idea | Status |\n|---|---|\n| Robust CLI | done |",
      },
    ]);
    expect(result.content).toContain("@ideas\n| Idea | Status |\n|---|---|\n| Robust CLI | done |\n\n@tasks");
  });

  test("appends to a named section", () => {
    const result = applyNoteEdits(source, [{ kind: "append-block", name: "log", type: "section", content: "New entry" }]);
    expect(result.content).toContain("Old entry\n\nNew entry");
  });

  test("returns 1-based block summaries with hashes", () => {
    const blocks = summarizeNoteEditBlocks(source);
    expect(blocks.map((block) => [block.name, block.type, block.line, block.startLine, block.endLine])).toEqual([
      ["ideas", "table", 5, 6, 8],
      ["tasks", "list", 10, 11, 12],
      ["log", "section", 14, 15, 17],
    ]);
    expect(blocks[0]?.hash).toMatch(/^sha256:/);
  });

  test("enforces content hash preconditions", () => {
    expect(() => applyNoteEdits(source, [{ kind: "append", content: "x" }], { ifContentHash: noteContentHash("different") })).toThrow(
      NoteEditError,
    );
  });

  test("enforces block hash preconditions", () => {
    const ideasHash = summarizeNoteEditBlocks(source).find((block) => block.name === "ideas")?.hash;
    const result = applyNoteEdits(source, [{ kind: "replace-block", name: "ideas", type: "table", content: "| Idea |\n|---|\n| ok |" }], {
      ifBlockHash: ideasHash,
    });
    expect(result.content).toContain("| ok |");
  });

  test("rejects ambiguous named block edits without an index", () => {
    const duplicated = `${source}\n@tasks\n- another\n`;
    expect(() => applyNoteEdits(duplicated, [{ kind: "append-block", name: "tasks", content: "- nope" }])).toThrow(NoteEditError);
  });
});

test("exact append joins JSON fragments byte-for-byte while default append keeps paragraphs", () => {
  const before = '# Map\n\n:::geo\n{"polyline6":"\\\\';
  const fragment = '😀\\\\","name":"東京"}\n:::\n';
  const exact = applyNoteEdits(before, [{ kind: "append", content: fragment, separator: "none" }], {
    ifContentHash: noteContentHash(before),
  });
  expect(exact.content).toBe(before + fragment);
  expect(exact.afterHash).toBe(noteContentHash(before + fragment));
  expect(applyNoteEdits("first", [{ kind: "append", content: "second" }]).content).toBe("first\n\nsecond");
  expect(applyNoteEdits("first\n", [{ kind: "append", content: "second" }]).content).toBe("first\nsecond");
  expect(applyNoteEdits("", [{ kind: "append", content: "second", separator: "none" }]).content).toBe("second");
  expect(() =>
    applyNoteEdits(before, [{ kind: "append", content: fragment, separator: "none" }], {
      ifContentHash: noteContentHash("external edit"),
    }),
  ).toThrow(NoteEditError);
});

test("the save helper composes the public schemas with actual Notebook edit semantics", async () => {
  const { saveMapNotebook } = await import("../../../cloud/src/ai/map-notebook-save");
  const { NoteCreateInputSchema, NoteEditInputSchema, NoteReadInputSchema } = await import("../capability-contracts");
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
