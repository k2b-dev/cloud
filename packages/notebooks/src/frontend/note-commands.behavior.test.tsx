import { expect, mock, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

if (!isServer) {
  const created: string[] = [];
  const navigated: string[] = [];
  mock.module("@/api/client", () => ({
    apiClient: {
      [":id"]: {
        notes: {
          $post: async ({ param }: { param: { id: string } }) => {
            created.push(param.id);
            return Response.json({ id: "Note01" });
          },
        },
      },
    },
  }));
  mock.module("./lib/soft-navigation", () => ({
    navigateToNotebookNote: async (href: string) => {
      navigated.push(href);
    },
  }));

  test("global new-note asks for a notebook, cancellation writes nothing, scoped new-note skips the chooser", async () => {
    const dom = createDomTestHarness();
    const { prompts } = await import("@k2b/ui");
    const { openCommand } = await import("@k2b/cloud/browser/commands");
    const { createNoteCommands } = await import("./note-commands");

    created.length = 0;
    navigated.length = 0;
    const choose = spyOn(prompts, "search").mockResolvedValue(undefined);
    const Owner = () => {
      createNoteCommands();
      return null;
    };
    const dispose = render(() => createComponent(Owner, {}), dom.root);
    try {
      await openCommand("notebooks.note.compose");
      expect(choose).toHaveBeenCalledTimes(1);
      expect(created).toEqual([]);
      choose.mockResolvedValue({ value: "Book01", label: "Journal" });
      await openCommand("notebooks.note.compose");
      expect(created).toEqual(["Book01"]);
      expect(navigated[0]).toContain("/Book01/notes/Note01");
      await openCommand("notebooks.note.compose", { notebookId: "Book02" });
      expect(choose).toHaveBeenCalledTimes(2);
      expect(created).toEqual(["Book01", "Book02"]);
    } finally {
      dispose();
      choose.mockRestore();
      dom.cleanup();
    }
  });

  test("leaving the page while choosing a notebook prevents creation", async () => {
    const dom = createDomTestHarness();
    const { prompts } = await import("@k2b/ui");
    const { openCommand } = await import("@k2b/cloud/browser/commands");
    const { createNoteCommands } = await import("./note-commands");

    created.length = 0;
    let choose!: (value: { value: string; label: string }) => void;
    const choice = new Promise<{ value: string; label: string }>((resolve) => {
      choose = resolve;
    });
    const search = spyOn(prompts, "search").mockReturnValue(choice);
    const Owner = () => {
      createNoteCommands();
      return null;
    };
    const dispose = render(() => createComponent(Owner, {}), dom.root);
    try {
      const pending = openCommand("notebooks.note.compose");
      await Promise.resolve();
      dispose();
      choose({ value: "Book01", label: "Journal" });
      await pending;
      expect(created).toEqual([]);
    } finally {
      dispose();
      search.mockRestore();
      dom.cleanup();
    }
  });
}
