import { expect, test } from "bun:test";
import { render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "./dom";

type Dropped = { name: string; type: string; size?: number };

/** A drag event as an engine dispatches it for files from outside the page, or for selected text. */
const dragEvent = (dom: DomTestHarness, type: string, files: Dropped[] | "text") => {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true }) as unknown as DragEvent;
  const list = files === "text" ? [] : files.map((file) => new File([new Uint8Array(file.size ?? 1)], file.name, { type: file.type }));
  Object.defineProperty(event, "dataTransfer", {
    value: {
      types: files === "text" ? ["text/plain"] : ["Files"],
      files: list,
      items: list.map((file) => ({ kind: "file", type: file.type })),
      dropEffect: "none",
    },
  });
  return event;
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a chat composer takes files dropped anywhere in its workspace main area, but never dragged text", async () => {
  const dom = createDomTestHarness();
  const { ChatComposer } = await import("../src/chat/ChatComposer");
  const selected: string[][] = [];
  const dispose = render(
    () => (
      <div class="k2b-app-workspace__main">
        <p id="history">An earlier answer</p>
        <ChatComposer
          value=""
          onValueChange={() => {}}
          onSubmit={() => {}}
          fileSelection={{ accept: "image/*", onSelect: (files) => void selected.push(files.map((file) => file.name)) }}
        />
      </div>
    ),
    dom.root,
  );
  try {
    await settle();
    const history = dom.document.getElementById("history")!;
    const text = dragEvent(dom, "drop", "text");
    history.dispatchEvent(text);
    expect(text.defaultPrevented).toBe(false);

    const drop = dragEvent(dom, "drop", [
      { name: "screenshot.png", type: "image/png" },
      { name: "notes.txt", type: "text/plain" },
    ]);
    history.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    await settle();
    expect(selected).toEqual([["screenshot.png"]]);
    expect(dom.document.body.textContent).toContain("Not added, this file type is not accepted here: notes.txt");
  } finally {
    dispose();
    dom.cleanup();
  }
});

test("a file dropzone inside a page target wins and says what happens while files are over it", async () => {
  const dom = createDomTestHarness();
  const { FileDropzone } = await import("../src/inputs/FileInputs");
  const { FileDropTarget } = await import("../src/inputs/FileDropTarget");
  const drops: string[] = [];
  const dispose = render(
    () => (
      <div class="k2b-app-workspace__main">
        <FileDropTarget label="Drop to attach to the message" onDrop={() => void drops.push("page")} />
        <FileDropzone
          label="Logo"
          accept="image/*"
          multiple={false}
          dropLabel="Drop to use as the logo"
          onDrop={(files) => void drops.push(`zone:${files[0]?.name}`)}
        />
      </div>
    ),
    dom.root,
  );
  try {
    await settle();
    const zone = dom.root.querySelector<HTMLButtonElement>(".k2b-dropzone")!;
    zone.dispatchEvent(dragEvent(dom, "dragenter", [{ name: "logo.png", type: "image/png" }]));
    expect(zone.dataset.fileDrop).toBe("over");
    expect(zone.textContent).toContain("Drop to use as the logo");
    expect(dom.document.querySelector(".k2b-file-drop")?.textContent).toContain("Drop to use as the logo");
    zone.dispatchEvent(
      dragEvent(dom, "drop", [
        { name: "logo.png", type: "image/png" },
        { name: "logo-dark.png", type: "image/png" },
      ]),
    );
    await settle();
    expect(drops).toEqual(["zone:logo.png"]);
    expect(zone.dataset.fileDrop).toBeUndefined();
    expect(dom.document.body.textContent).toContain("Only one file at a time. Not added: logo-dark.png");
  } finally {
    dispose();
    dom.cleanup();
  }
});

test("a file dropzone with `choose` asks it on click instead of the device dialog, and still takes drops", async () => {
  const dom = createDomTestHarness();
  const { FileDropzone } = await import("../src/inputs/FileInputs");
  const received: string[][] = [];
  let answer: File[] = [];
  let asked = 0;
  const dispose = render(
    () => (
      <FileDropzone
        label="Attachment"
        multiple={false}
        choose={async () => {
          asked++;
          return answer;
        }}
        onDrop={(files) => void received.push(files.map((file) => file.name))}
      />
    ),
    dom.root,
  );
  try {
    await settle();
    const zone = dom.root.querySelector<HTMLButtonElement>(".k2b-dropzone")!;
    // The zone is the only control, so neither a dialog's first focus nor a key press reaches the device's dialog.
    expect(dom.root.querySelector('input[type="file"]')).toBeNull();

    // A cancelled choice adds nothing.
    zone.click();
    await settle();
    expect([asked, received.length]).toEqual([1, 0]);

    // A single-file zone keeps the first chosen file, like a drop.
    answer = [new File(["a"], "minutes.pdf"), new File(["b"], "agenda.pdf")];
    zone.click();
    await settle();
    expect(received).toEqual([["minutes.pdf"]]);

    zone.dispatchEvent(dragEvent(dom, "drop", [{ name: "photo.png", type: "image/png" }]));
    await settle();
    expect(received).toEqual([["minutes.pdf"], ["photo.png"]]);
  } finally {
    dispose();
    dom.cleanup();
  }
});

test("a file dropzone whose `choose` fails says why, and the next choice clears it", async () => {
  const dom = createDomTestHarness();
  const { FileDropzone } = await import("../src/inputs/FileInputs");
  const received: string[][] = [];
  let failure: Error | undefined = new Error("Files is not available right now.");
  const dispose = render(
    () => (
      <FileDropzone
        label="Attachment"
        choose={async () => {
          if (failure) throw failure;
          return [new File(["a"], "minutes.pdf")];
        }}
        onDrop={(files) => void received.push(files.map((file) => file.name))}
      />
    ),
    dom.root,
  );
  try {
    await settle();
    const zone = dom.root.querySelector<HTMLButtonElement>(".k2b-dropzone")!;
    zone.click();
    await settle();
    expect(dom.root.textContent).toContain("Files is not available right now.");
    expect(zone.dataset.invalid).toBe("true");
    expect(zone.getAttribute("aria-invalid")).toBe("true");
    expect(dom.document.getElementById(zone.getAttribute("aria-describedby")!)?.textContent).toBe("Files is not available right now.");
    expect(received).toEqual([]);

    failure = undefined;
    zone.click();
    await settle();
    expect(dom.root.textContent).not.toContain("Files is not available right now.");
    expect(zone.dataset.invalid).toBeUndefined();
    expect(zone.getAttribute("aria-invalid")).toBeNull();
    expect(received).toEqual([["minutes.pdf"]]);
  } finally {
    dispose();
    dom.cleanup();
  }
});

test("a chat composer with `choose` asks it for Attach files and hands the result to onSelect", async () => {
  const dom = createDomTestHarness();
  const { ChatComposer } = await import("../src/chat/ChatComposer");
  const selected: string[][] = [];
  let answer: File[] = [];
  let asked = 0;
  const dispose = render(
    () => (
      <ChatComposer
        value=""
        onValueChange={() => {}}
        onSubmit={() => {}}
        fileSelection={{
          choose: async () => {
            asked++;
            return answer;
          },
          onSelect: (files) => void selected.push(files.map((file) => file.name)),
        }}
      />
    ),
    dom.root,
  );
  try {
    await settle();
    const trigger = dom.root.querySelector<HTMLButtonElement>('[aria-label="Add to chat"]')!;
    const attach = () => {
      trigger.click();
      const menu = dom.document.getElementById(trigger.getAttribute("aria-controls")!)!;
      Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
        .find((item) => item.textContent?.includes("Attach files"))!
        .click();
    };
    let deviceDialogs = 0;
    dom.root.querySelector<HTMLInputElement>('input[type="file"]')?.addEventListener("click", () => deviceDialogs++);

    attach();
    await settle();
    expect([asked, selected.length]).toEqual([1, 0]);

    answer = [new File(["a"], "report.pdf"), new File(["b"], "chart.png")];
    attach();
    await settle();
    await settle();
    expect(selected).toEqual([["report.pdf", "chart.png"]]);
    expect(deviceDialogs).toBe(0);
  } finally {
    dispose();
    dom.cleanup();
  }
});

test("a single-file chat composer keeps the first file `choose` hands it", async () => {
  const dom = createDomTestHarness();
  const { ChatComposer } = await import("../src/chat/ChatComposer");
  const selected: string[][] = [];
  const dispose = render(
    () => (
      <ChatComposer
        value=""
        onValueChange={() => {}}
        onSubmit={() => {}}
        fileSelection={{
          multiple: false,
          choose: async () => [new File(["a"], "report.pdf"), new File(["b"], "chart.png")],
          onSelect: (files) => void selected.push(files.map((file) => file.name)),
        }}
      />
    ),
    dom.root,
  );
  try {
    await settle();
    const trigger = dom.root.querySelector<HTMLButtonElement>('[aria-label="Add to chat"]')!;
    trigger.click();
    const menu = dom.document.getElementById(trigger.getAttribute("aria-controls")!)!;
    Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((item) => item.textContent?.includes("Attach files"))!
      .click();
    await settle();
    await settle();
    expect(selected).toEqual([["report.pdf"]]);
  } finally {
    dispose();
    dom.cleanup();
  }
});
