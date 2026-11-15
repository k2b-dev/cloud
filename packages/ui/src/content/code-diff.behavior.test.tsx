import { afterEach, describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../test/dom";
import type { CodeDiffFile, CodeDiffLocation } from "./CodeDiff";

// Lines keep their element while their rows stay, so content below a line survives; new rows must still render anew.
// Runs with browser conditions and the repository's Solid DOM preload. Fixtures are fictional.
describe("CodeDiff rows across changes", () => {
  if (isServer) {
    test.skip("requires the dedicated browser-conditions process", () => {});
    return;
  }
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  const code: CodeDiffFile = {
    path: "code.ts",
    lines: [
      { kind: "add", text: "export const a = 1;" },
      { kind: "add", text: "export const b = 2;" },
    ],
  };
  const compared: CodeDiffFile = {
    path: "code.ts",
    lines: [
      { kind: "del", text: "export const a = 0;" },
      { kind: "add", text: "export const a = 1;" },
      { kind: "same", text: "export const b = 2;" },
    ],
  };

  const mount = async () => {
    const dom = createDomTestHarness();
    const { CodeDiff } = await import("./CodeDiff");
    const [files, setFiles] = createSignal<CodeDiffFile[]>([code]);
    const [slotLines, setSlotLines] = createSignal<CodeDiffLocation[]>([]);
    const dispose = render(
      () => (
        <CodeDiff
          files={files()}
          lineAction={{ label: ({ line }) => `Comment on line ${line}`, onSelect: () => {} }}
          slotLines={slotLines()}
          lineSlot={({ line }) => <p class="note">Note on line {line}</p>}
        />
      ),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    return { dom, setFiles, setSlotLines };
  };

  test("the same file compared with another version renders the new rows, not the old lines", async () => {
    const { dom, setFiles } = await mount();
    expect(dom.root.querySelectorAll('[data-kind="del"]')).toHaveLength(0);
    setFiles([compared]);
    expect(dom.root.querySelectorAll('[data-kind="del"]')).toHaveLength(1);
    expect(dom.root.querySelector('[data-row="0"] code')?.textContent).toContain("export const a = 0;");
    setFiles([code]);
    expect(dom.root.querySelectorAll('[data-kind="del"]')).toHaveLength(0);
    expect(dom.root.querySelector('[data-row="0"] code')?.textContent).toContain("export const a = 1;");
  });

  test("content below a line keeps its element while another line gets content", async () => {
    const { dom, setSlotLines } = await mount();
    setSlotLines([{ path: "code.ts", line: 1 }]);
    const first = dom.root.querySelector(".note");
    expect(first?.textContent).toBe("Note on line 1");
    setSlotLines([
      { path: "code.ts", line: 1 },
      { path: "code.ts", line: 2 },
    ]);
    expect(dom.root.querySelectorAll(".note")).toHaveLength(2);
    expect(dom.root.querySelector(".note")).toBe(first);
  });
});
