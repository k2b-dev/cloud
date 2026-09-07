import { afterEach, describe, expect, test } from "bun:test";
import { launchNotebookNoteAssistant } from "./notebook-assistant-launch";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Notebooks Assistant launch", () => {
  test("launches with the current note, canonical link, discussion context, and edit tools", async () => {
    let launchBody = "";
    globalThis.fetch = Object.assign(
      async (_request: RequestInfo | URL, init?: RequestInit) => {
        launchBody = String(init?.body);
        return Response.json({ id: "Cht001", draft: { content: [], revision: 1, updatedAt: null } }, { status: 201 });
      },
      { preconnect: originalFetch.preconnect },
    );

    const launch = await launchNotebookNoteAssistant({
      notebookId: "abc123",
      noteId: "def456",
      noteTitle: "Company handbook",
    });

    expect(launch.href).toBe("/app/assistant?conversation=Cht001");
    expect(JSON.parse(launchBody)).toEqual({
      launchedByAppId: "notebooks",
      title: "Company handbook",
      draft: {
        content: [
          {
            type: "text",
            text: "Help me edit this note. Read the current note and its discussion before suggesting or applying changes.",
          },
          {
            type: "resource",
            ref: { type: "notebooks.note", id: "def456" },
            title: "Company handbook",
            icon: "ti ti-file-text",
            href: "/app/notebooks/abc123/notes/def456",
          },
        ],
      },
      preloadTools: [
        { name: "text_editor" },
        { appId: "notebooks", kind: "query", id: "note.read" },
        { appId: "notebooks", kind: "query", id: "note.preview" },
        { appId: "notebooks", kind: "query", id: "comment.list" },
        { appId: "notebooks", kind: "action", id: "note.edit" },
      ],
    });
  });
});
