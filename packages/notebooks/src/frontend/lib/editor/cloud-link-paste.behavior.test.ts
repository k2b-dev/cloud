import { describe, expect, spyOn, test } from "bun:test";
import { history, undo } from "@codemirror/commands";
import { forceParsing } from "@codemirror/language";
import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import { markdownExtension } from "./markdown";

describe("pasted Cloud links", () => {
  if (isServer) {
    test.skip("pasted Cloud links run with browser export conditions", () => {});
    return;
  }

  const LINK = "https://cloud.example/app/spaces/Spc001?item=Itm001";
  const NOTE_LINK = "https://cloud.example/app/notebooks/Nb12Cd/notes/Nt34Ef";
  const ODD_LINK = "https://cloud.example/app/spaces/Spc001?item=Odd001";
  const resolved: Record<string, object> = {
    [LINK]: { ref: { type: "spaces.item", id: "Itm001" }, title: "Pallets [north]\ndock", href: "/app/spaces/Spc001?item=Itm001" },
    [NOTE_LINK]: { ref: { type: "notebooks.note", id: "Nt34Ef" }, title: "Goods receipt", href: "/app/notebooks/Nb12Cd/notes/Nt34Ef" },
    [ODD_LINK]: { ref: { type: "spaces.item", id: "a(b)" }, title: "Odd", href: "/app/spaces/Spc001?item=a(b)" },
  };

  /** An editor with the paste recognition; `answer()` lets the resolve request finish. */
  const mount = async (doc: string, selection: EditorSelection | { anchor: number }) => {
    const dom = createDomTestHarness();
    const shell = document.createElement("script");
    shell.id = "cloud-shell-data";
    shell.type = "application/json";
    shell.textContent = JSON.stringify({ cloudOrigin: "https://cloud.example" });
    document.body.append(shell);
    let answer = () => {};
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          await answered;
          const body = resolved[(JSON.parse(String(init?.body)) as { url: string }).url];
          return body ? Response.json(body) : Response.json({ error: "Resource not found" }, { status: 404 });
        },
        { preconnect: fetch.preconnect },
      ),
    );
    const { cloudLinkPasteExtension } = await import("./cloud-link-paste");
    const readOnly = new Compartment();
    const view = new EditorView({
      parent: dom.root,
      state: EditorState.create({
        doc,
        selection,
        extensions: [
          markdownExtension(),
          history(),
          EditorState.allowMultipleSelections.of(true),
          readOnly.of([]),
          cloudLinkPasteExtension(),
        ],
      }),
    });
    const paste = async (text: string) => {
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { getData: (type: string) => (type === "text/plain" ? text : "") } });
      view.contentDOM.dispatchEvent(event);
      await Promise.resolve();
      forceParsing(view, view.state.doc.length, 5000);
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    const settle = async () => {
      answer();
      await new Promise((resolve) => setTimeout(resolve, 20));
    };
    return {
      view,
      lock: () => view.dispatch({ effects: readOnly.reconfigure(EditorState.readOnly.of(true)) }),
      paste,
      settle,
      text: () => view.state.doc.toString(),
      cleanup: () => {
        view.destroy();
        fetchSpy.mockRestore();
        shell.remove();
        dom.cleanup();
      },
    };
  };

  const pasteInto = async (before: string, text: string, after = "") => {
    const editor = await mount(before + after, { anchor: before.length });
    try {
      await editor.paste(text);
      await editor.settle();
      return editor.text();
    } finally {
      editor.cleanup();
    }
  };

  test("a recognized link becomes a Markdown link with the resource's title on one line", async () => {
    expect(await pasteInto("See ", LINK, " today")).toBe("See [Pallets \\[north\\] dock](/open/spaces.item/~Itm001) today");
    expect(await pasteInto("", ODD_LINK)).toBe("[Odd](/open/spaces.item/~a%28b%29)");
  });

  test("a note keeps the editor's own note link, also from Windows line endings", async () => {
    expect(await pasteInto("", `${NOTE_LINK}\r\n`)).toBe("[Goods receipt](note://Nt34Ef)\n");
  });

  test("unknown links, code, autolinks, link destinations and other text stay as pasted", async () => {
    const unknown = "https://cloud.example/app/spaces/Spc001?item=Gone01";
    expect(await pasteInto("", unknown)).toBe(unknown);
    expect(await pasteInto("`", LINK, "`")).toBe(`\`${LINK}\``);
    expect(await pasteInto("<", LINK, ">")).toBe(`<${LINK}>`);
    expect(await pasteInto("[Dock](", LINK, ")")).toBe(`[Dock](${LINK})`);
    expect(await pasteInto("", `Link: ${LINK}`)).toBe(`Link: ${LINK}`);
    expect(await pasteInto("", "https://other.example/app/spaces/Spc001?item=Itm001")).toBe(
      "https://other.example/app/spaces/Spc001?item=Itm001",
    );
  });

  test("every cursor's copy is recognized", async () => {
    const editor = await mount("A \nB ", EditorSelection.create([EditorSelection.cursor(2), EditorSelection.cursor(5)]));
    try {
      await editor.paste(LINK);
      await editor.settle();
      const link = "[Pallets \\[north\\] dock](/open/spaces.item/~Itm001)";
      expect(editor.text()).toBe(`A ${link}\nB ${link}`);
    } finally {
      editor.cleanup();
    }
  });

  test("one line per cursor: CodeMirror gives the link line to the first cursor, which is recognized", async () => {
    const editor = await mount("A \nB ", EditorSelection.create([EditorSelection.cursor(2), EditorSelection.cursor(5)]));
    try {
      await editor.paste(`${LINK}\r\n`);
      await editor.settle();
      expect(editor.text()).toBe("A [Pallets \\[north\\] dock](/open/spaces.item/~Itm001)\nB ");
    } finally {
      editor.cleanup();
    }
  });

  test("a note that turns read-only before Cloud answers keeps the pasted link", async () => {
    const editor = await mount("", { anchor: 0 });
    try {
      await editor.paste(LINK);
      editor.lock();
      await editor.settle();
      expect(editor.text()).toBe(LINK);
    } finally {
      editor.cleanup();
    }
  });

  test("a paste undone before Cloud answers leaves the same link elsewhere alone", async () => {
    const editor = await mount(`${LINK}\n`, { anchor: LINK.length + 1 });
    try {
      await editor.paste(LINK);
      undo(editor.view);
      await editor.settle();
      expect(editor.text()).toBe(`${LINK}\n`);
    } finally {
      editor.cleanup();
    }
  });

  test("undo after recognition brings back the plain link", async () => {
    const editor = await mount("", { anchor: 0 });
    try {
      await editor.paste(LINK);
      await editor.settle();
      expect(editor.text()).toStartWith("[Pallets");
      undo(editor.view);
      expect(editor.text()).toBe(LINK);
    } finally {
      editor.cleanup();
    }
  });
});
