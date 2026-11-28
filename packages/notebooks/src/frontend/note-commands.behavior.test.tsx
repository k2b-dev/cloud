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
  // the writable notebooks the chooser finds, in the order the capability returns them
  mock.module("@k2b/cloud/capabilities", () => ({
    invokeCapabilityWithDataSchema: async () => ({
      ok: true,
      data: { data: ["Book02", "Book01", "Book03"].map((id) => ({ ref: { id }, title: `Notebook ${id}` })) },
    }),
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

  test("a notebook's page makes a new note in another notebook it is asked for, and in its own without asking", async () => {
    const dom = createDomTestHarness();
    const { prompts } = await import("@k2b/ui");
    const { openCommand } = await import("@k2b/cloud/browser/commands");
    const { createNoteCommands } = await import("./note-commands");

    created.length = 0;
    navigated.length = 0;
    const choose = spyOn(prompts, "search").mockResolvedValue(undefined);
    // Notebooks opens the notebook used last, so a command link from another app for any notebook arrives here
    const Owner = () => {
      createNoteCommands(() => "Book01");
      return null;
    };
    const dispose = render(() => createComponent(Owner, {}), dom.root);
    const assign = spyOn(window.location, "assign").mockImplementation(() => {});
    try {
      await openCommand("notebooks.note.compose", { notebookId: "Book02" });
      expect(created).toEqual(["Book02"]);
      expect(navigated[0]).toContain("/Book02/notes/Note01");
      await openCommand("notebooks.note.compose");
      expect(created).toEqual(["Book02", "Book01"]);
      expect(choose).not.toHaveBeenCalled();
      expect(assign).not.toHaveBeenCalled();
    } finally {
      dispose();
      assign.mockRestore();
      choose.mockRestore();
      dom.cleanup();
    }
  });

  test("a New note link from another app asks even on a writable notebook, with that notebook first", async () => {
    const dom = createDomTestHarness();
    const { prompts } = await import("@k2b/ui");
    const { createNoteCommands } = await import("./note-commands");

    created.length = 0;
    navigated.length = 0;
    const choose = spyOn(prompts, "search").mockResolvedValue({ value: "Book01", label: "Notebook Book01" });
    // /app/notebooks sent the link on to the notebook used last, which shows it
    window.history.replaceState(null, "", "/app/notebooks/Book01?command=notebooks.note.compose&commandInput=%7B%7D");
    const Owner = () => {
      createNoteCommands(() => "Book01");
      return null;
    };
    const dispose = render(() => createComponent(Owner, {}), dom.root);
    try {
      for (let attempt = 0; attempt < 50 && created.length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 0));
      expect(choose).toHaveBeenCalledTimes(1);
      const [resolve] = choose.mock.calls[0]!;
      const offered = await resolve({ query: "", abortSignal: new AbortController().signal });
      // the notebook used last stands first, so one confirm takes it
      expect(offered.map((item) => [item.value, item.desc])).toEqual([
        ["Book01", "Last used"],
        ["Book02", undefined],
        ["Book03", undefined],
      ]);
      expect(created).toEqual(["Book01"]);
      expect(window.location.search).toBe("");
      // once the link is taken, New note inside this writable notebook writes here again without asking
      const { openCommand } = await import("@k2b/cloud/browser/commands");
      await openCommand("notebooks.note.compose");
      expect(created).toEqual(["Book01", "Book01"]);
      expect(choose).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
      choose.mockRestore();
      dom.cleanup();
    }
  });

  test("reading a notebook asks for a new note too, with the notebook first when it may be written", async () => {
    const dom = createDomTestHarness();
    const { prompts } = await import("@k2b/ui");
    const { openCommand } = await import("@k2b/cloud/browser/commands");
    const { createNoteCommands } = await import("./note-commands");

    created.length = 0;
    const choose = spyOn(prompts, "search").mockResolvedValue(undefined);
    const Owner = () => {
      createNoteCommands(() => "Book03", { ask: true });
      return null;
    };
    const dispose = render(() => createComponent(Owner, {}), dom.root);
    try {
      await openCommand("notebooks.note.compose");
      expect(choose).toHaveBeenCalledTimes(1);
      const offered = await choose.mock.calls[0]![0]({ query: "", abortSignal: new AbortController().signal });
      expect(offered.map((item) => item.value)).toEqual(["Book03", "Book02", "Book01"]);
      expect(created).toEqual([]);
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
      // openCommand loads its validators first, so the chooser opens after a few turns.
      while (search.mock.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
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
