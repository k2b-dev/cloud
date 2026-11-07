import { describe, expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

const loading = createDomTestHarness();
const { EditorSelection } = await import("@codemirror/state");
const { LocaleProvider } = await import("@k2b/ui");
const { Editor, Toolbar, createEditor, dictationTarget } = await import("./index");
loading.cleanup();

const mount = (doc: string) => {
  const dom = createDomTestHarness();
  let editor!: ReturnType<typeof createEditor>;
  let target!: ReturnType<typeof dictationTarget>;
  const dispose = render(() => {
    editor = createEditor();
    target = dictationTarget(editor);
    return (
      <LocaleProvider locale="en">
        <Editor editor={editor} label="Note" initialValue={doc} maxLength={10_000} toolbar={false} />
      </LocaleProvider>
    );
  }, dom.root);
  const view = () => {
    const current = editor.view();
    if (!current) throw new Error("The editor did not mount");
    return current;
  };
  return {
    dom,
    target,
    view,
    text: () => view().state.doc.toString(),
    [Symbol.dispose]() {
      dispose();
      dom.cleanup();
    },
  };
};

const settle = () => new Promise((done) => setTimeout(done, 0));

describe("@k2b/editor dictation", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  test("writes at the mark between existing lines, with one space after earlier words", async () => {
    using note = mount("- Strom klären\n- \n- Angebot bis Freitag");
    await settle();
    note.view().dispatch({ selection: EditorSelection.cursor(17) });
    note.target.begin();
    note.target.insert(" Zwei Steckdosen");
    note.target.insert(" an der Rückwand");
    expect(note.text()).toBe("- Strom klären\n- Zwei Steckdosen an der Rückwand\n- Angebot bis Freitag");
    expect(note.dom.root.querySelectorAll(".k2b-dictation-mark").length).toBe(1);
    const fresh = [...note.dom.root.querySelectorAll(".k2b-dictation-fresh")].map((word) => word.textContent).join("");
    expect(fresh).toContain("Rückwand");
    note.target.end();
    expect(note.dom.root.querySelectorAll(".k2b-dictation-mark").length).toBe(0);
  });

  test("an edit elsewhere, also from another person, moves the mark along", async () => {
    using note = mount("Aufbau. Ende.");
    await settle();
    note.view().dispatch({ selection: EditorSelection.cursor(7) });
    note.target.begin();
    note.target.insert("Donnerstag");
    // Someone else types at the very start, as a shared document's remote change arrives.
    note.view().dispatch({ changes: { from: 0, insert: "Neu: " }, annotations: [] });
    note.target.insert(" ab 8 Uhr");
    expect(note.text()).toBe("Neu: Aufbau. Donnerstag ab 8 Uhr Ende.");
  });

  test("a pause with a new session writes on at the same mark", async () => {
    using note = mount("Start");
    await settle();
    note.view().dispatch({ selection: EditorSelection.cursor(5) });
    note.target.begin();
    note.target.insert("eins");
    note.target.begin();
    note.target.insert("zwei");
    expect(note.text()).toBe("Start eins zwei");
  });

  test("discard removes only the dictated ranges and keeps text that was there", async () => {
    using note = mount("Vorher.");
    await settle();
    note.view().dispatch({ selection: EditorSelection.cursor(7) });
    note.target.begin();
    note.target.insert("Diktiert");
    // The person types after the dictated words; that text is theirs and stays.
    const end = note.text().length;
    note.view().dispatch({ changes: { from: end, insert: " getippt" } });
    note.target.begin();
    note.target.insert("mehr");
    note.target.discard();
    expect(note.text()).toBe("Vorher. getippt");
  });

  test("words from the toolbar's source keep the session live while the note changes", async () => {
    const dom = createDomTestHarness();
    let emit: (event: import("@k2b/ui").DictationEvent) => void = () => {};
    const source: import("@k2b/ui").DictationSource = {
      devices: async () => [],
      start: () => {
        const queue: import("@k2b/ui").DictationEvent[] = [];
        let wake: (() => void) | undefined;
        emit = (event) => {
          queue.push(event);
          wake?.();
        };
        return {
          events: {
            async *[Symbol.asyncIterator]() {
              while (true) {
                const event = queue.shift();
                if (event) yield event;
                else await new Promise<void>((done) => (wake = done));
              }
            },
          },
          stop: async () => {},
        };
      },
    };
    let editor!: ReturnType<typeof createEditor>;
    const dispose = render(() => {
      editor = createEditor();
      return (
        <LocaleProvider locale="en">
          <Editor editor={editor} label="Note" initialValue="Start" maxLength={10_000} toolbar={false} />
          <Toolbar editor={editor} groups={[]} dictation={{ source }} />
        </LocaleProvider>
      );
    }, dom.root);
    try {
      await settle();
      editor.view()!.dispatch({ selection: EditorSelection.cursor(5) });
      dom.root.querySelector<HTMLButtonElement>('button[aria-label="Dictate"]')!.click();
      emit({ type: "state", state: "live", maxMs: 600_000 });
      for (const word of ["one", " two", " three"]) {
        emit({ type: "text", text: word });
        await settle();
      }
      expect(editor.view()!.state.doc.toString()).toBe("Start one two three");
      expect(dom.root.querySelector('[role="group"][aria-label="Dictating"]')).not.toBeNull();
    } finally {
      dispose();
      dom.cleanup();
    }
  });
});
