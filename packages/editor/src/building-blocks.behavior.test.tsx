import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

const loading = createDomTestHarness();
const { EditorSelection } = await import("@codemirror/state");
const { LocaleProvider } = await import("@k2b/ui");
const { Editor, Toolbar, SlashMenu, createEditor, markdownActions, slashCompletionSource } = await import("./index");
const { CompletionContext, currentCompletions, startCompletion } = await import("@codemirror/autocomplete");
loading.cleanup();

/** One editor with a toolbar outside it, as a host places them. */
const mount = (doc: string, slash: import("./index").SlashAction[] = []) => {
  const dom = createDomTestHarness();
  let editor!: ReturnType<typeof createEditor>;
  const dispose = render(() => {
    editor = createEditor();
    const actions = markdownActions(editor, "en");
    return (
      <LocaleProvider locale="en">
        <Toolbar editor={editor} groups={[{ items: [actions.bold, actions.italic] }, { items: [actions.bulletList] }]} />
        <Editor editor={editor} label="Note" initialValue={doc} maxLength={10_000} toolbar={false} />
        <SlashMenu editor={editor} actions={slash} />
      </LocaleProvider>
    );
  }, dom.root);
  const view = () => {
    const current = editor.view();
    if (!current) throw new Error("The editor did not mount");
    return current;
  };
  const button = (label: string) => {
    const found = dom.root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (!found) throw new Error(`Missing ${label}`);
    return found;
  };
  return {
    dom,
    editor,
    view,
    button,
    select(from: number, to: number) {
      view().dispatch({ selection: EditorSelection.single(from, to) });
    },
    [Symbol.dispose]() {
      dispose();
      dom.cleanup();
    },
  };
};

describe("@k2b/editor building blocks", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  test("a toolbar placed outside the editor formats the selection apart from the typing before it", async () => {
    const { undo } = await import("@codemirror/commands");
    using page = mount("word here");
    await Promise.resolve();
    const view = page.view();
    view.dispatch({ changes: { from: 9, insert: "!" }, selection: { anchor: 10 }, userEvent: "input.type" });
    page.select(0, 4);
    page.button("Bold").click();
    expect(view.state.doc.toString()).toBe("**word** here!");
    undo(view);
    expect(view.state.doc.toString()).toBe("word here!");
  });

  test("the pressed state follows the caret through the shared state", async () => {
    using page = mount("**bold** plain");
    await Promise.resolve();
    page.select(3, 3);
    expect(page.button("Bold").getAttribute("aria-pressed")).toBe("true");
    page.select(11, 11);
    expect(page.button("Bold").getAttribute("aria-pressed")).toBe("false");
  });

  test("a read-only editor ignores an action without its own enabled check", async () => {
    using page = mount("word");
    await Promise.resolve();
    page.editor.controller()?.setReadOnly(true);
    const action: import("./index").EditorAction = {
      id: "insert",
      icon: "ti-plus",
      label: "Insert",
      run: (view: import("@codemirror/view").EditorView) => view.dispatch({ changes: { from: 0, insert: "x" } }),
    };
    expect(page.editor.isEnabled(action)).toBe(false);
    page.editor.run(action);
    expect(page.view().state.doc.toString()).toBe("word");
  });

  test("a read-only editor disables the actions and ignores presses", async () => {
    using page = mount("word");
    await Promise.resolve();
    page.editor.controller()?.setReadOnly(true);
    page.select(0, 4);
    expect(page.button("Bold").getAttribute("aria-disabled")).toBe("true");
    page.button("Bold").click();
    expect(page.view().state.doc.toString()).toBe("word");
  });

  test("reactive extensions reconfigure only their own slot of the one view", async () => {
    const { EditorState, Facet } = await import("@codemirror/state");
    const { EditorView } = await import("@codemirror/view");
    const { createSignal } = await import("solid-js");
    const dom = createDomTestHarness();
    const marker = Facet.define<string, string[]>();
    const [mode, setMode] = createSignal("rich");
    const { editor, dispose } = createRoot((dispose) => {
      const editor = createEditor();
      editor.use(marker.of("static"));
      editor.use(() => marker.of(mode()));
      return { editor, dispose };
    });
    await Promise.resolve();
    const view = new EditorView({ parent: dom.root, state: EditorState.create({ extensions: editor.extension() }) });
    try {
      editor.attach(view);
      expect(view.state.facet(marker)).toEqual(["static", "rich"]);
      setMode("source");
      await Promise.resolve();
      expect(view.state.facet(marker)).toEqual(["static", "source"]);
    } finally {
      dispose();
      view.destroy();
      dom.cleanup();
    }
  });

  test("an extension added after mount joins the view and leaves with its owner", async () => {
    using page = mount("text");
    await Promise.resolve();
    const { EditorView } = await import("@codemirror/view");
    const seen: number[] = [];
    const dispose = createRoot((dispose) => {
      page.editor.use(EditorView.updateListener.of((update) => seen.push(update.state.doc.length)));
      return dispose;
    });
    await Promise.resolve();
    page.view().dispatch({ changes: { from: 4, insert: "!" } });
    expect(seen.at(-1)).toBe(5);
    dispose();
    await Promise.resolve();
    page.view().dispatch({ changes: { from: 5, insert: "?" } });
    expect(seen.at(-1)).toBe(5);
  });

  test("a factory that reads a signal written during an editor update leaves the writing plugin running", async () => {
    const { createSignal } = await import("solid-js");
    const { Facet } = await import("@codemirror/state");
    const { ViewPlugin } = await import("@codemirror/view");
    using page = mount("text");
    await Promise.resolve();
    const marker = Facet.define<number, number[]>();
    const [length, setLength] = createSignal(4);
    let updates = 0;
    const errors: unknown[] = [];
    const logged = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    const dispose = createRoot((dispose) => {
      // Like a Yjs binding whose document store a host reads: the plugin writes a signal while the view updates.
      page.editor.use(
        ViewPlugin.define(() => ({
          update(update) {
            updates++;
            if (update.docChanged) setLength(update.state.doc.length);
          },
        })),
      );
      page.editor.use(() => marker.of(length()));
      return dispose;
    });
    try {
      await Promise.resolve();
      const view = page.view();
      view.dispatch({ changes: { from: 4, insert: "!" } });
      view.dispatch({ changes: { from: 5, insert: "?" } });
      await Promise.resolve();
      expect(errors).toEqual([]);
      // CodeMirror switches off a plugin that crashed; this one saw both edits and the reconfiguration after them.
      expect(updates).toBeGreaterThanOrEqual(3);
      expect(view.state.facet(marker)).toEqual([6]);
    } finally {
      console.error = logged;
      dispose();
    }
  });

  test("a host effect that dispatches to the view does not run again on every editor update", async () => {
    const { createEffect, createSignal } = await import("solid-js");
    const { StateEffect } = await import("@codemirror/state");
    using page = mount("text");
    await Promise.resolve();
    const ping = StateEffect.define<number>();
    const [value, setValue] = createSignal(0);
    let runs = 0;
    const dispose = createRoot((dispose) => {
      createEffect(() => {
        runs++;
        page.editor.view()?.dispatch({ effects: ping.of(value()) });
      });
      return dispose;
    });
    setValue(1);
    page.view().dispatch({ changes: { from: 4, insert: "!" } });
    expect(runs).toBe(2);
    dispose();
  });
});

describe("line formats", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  test.each(["heading1", "heading2", "heading3", "bulletList", "numberedList", "quote"] as const)(
    "%s on an empty line leaves the caret after its prefix",
    (id) => {
      using page = mount("");
      const view = page.view();
      markdownActions(createEditor(), "en")[id].run(view);
      const { doc, selection } = view.state;
      expect(doc.length).toBeGreaterThan(0);
      expect(selection.main.head).toBe(doc.length);
    },
  );
});

describe("slash menu matching", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  const run = () => {};
  const actions = [
    { id: "heading", name: "h", label: "Heading", icon: "ti-h-1", params: /^([1-6])$/, run },
    { id: "table", name: "table", label: "Table", icon: "ti-table", params: /^(\d+)x(\d+)$/, run },
    { id: "chart", name: "chart", label: "Chart", icon: "ti-chart-bar", aliases: ["diagram"], description: "from a table", run },
    { id: "locked", name: "locked", label: "Locked", icon: "ti-lock", isEnabled: () => false, run },
  ];
  const complete = async (doc: string) => {
    const { EditorState } = await import("@codemirror/state");
    const state = EditorState.create({ doc, selection: { anchor: doc.length } });
    return slashCompletionSource(actions)(new CompletionContext(state, doc.length, false));
  };

  test("exact names and parameters come first, aliases match, disabled actions stay out", async () => {
    expect((await complete("/"))?.options.map((option) => option.displayLabel)).toEqual(["Heading", "Table", "Chart"]);
    expect((await complete("/table2x4"))?.options[0]?.displayLabel).toBe("Table");
    expect((await complete("/diagram"))?.options[0]?.displayLabel).toBe("Chart");
    expect((await complete("/chrt"))?.options.map((option) => option.displayLabel)).toEqual(["Chart"]);
    expect(await complete("text/table")).toBeNull();
    expect((await complete("text /ta"))?.from).toBe(5);
    // A German name with an umlaut keeps the menu open while typing.
    expect((await complete("/ü"))?.options).toEqual([]);
  });

  test("picking an action removes the typed name and runs it on a fresh line mid-text", async () => {
    let ran: RegExpMatchArray | undefined;
    using page = mount("text ", [
      {
        ...actions[1]!,
        run: (_view, params) => {
          ran = params;
        },
      },
    ]);
    await Promise.resolve();
    const view = page.view();
    view.dispatch({ changes: { from: 5, insert: "/table2x3" }, selection: { anchor: 14 }, userEvent: "input.type" });
    startCompletion(view);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const option = currentCompletions(view.state)[0];
    expect(option?.displayLabel).toBe("Table");
    if (!option || typeof option.apply !== "function") throw new Error("Missing completion");
    option.apply(view, option, 5, 14);
    await Promise.resolve();
    expect(view.state.doc.toString()).toBe("text \n");
    expect(ran?.slice(1)).toEqual(["2", "3"]);
  });
});
