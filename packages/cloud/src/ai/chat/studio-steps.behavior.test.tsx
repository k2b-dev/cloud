import { afterAll, expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { AiTurnBlock } from "../protocol";

const open = (details: HTMLDetailsElement) => {
  details.open = true;
  details.dispatchEvent(new Event("toggle"));
};

// Solid delegates clicks to the document that was current when the views loaded, so all tests share one document.
let dom: ReturnType<typeof createDomTestHarness> | undefined;
afterAll(() => dom?.cleanup());

const mount = async (blocks: () => AiTurnBlock[], options: { locale?: string; opened?: string[] } = {}) => {
  dom ??= createDomTestHarness();
  const root = dom.root.appendChild(document.createElement("div"));
  const { AiTurnView } = await import("./turn-view");
  const { layoutAiTurn } = await import("./turn-layout");
  const { createAiToolDisclosureState } = await import("./tool-disclosure");
  const { AiChatActionsProvider } = await import("./message-actions");
  const { LocaleProvider } = await import("@k2b/ui");
  const disclosureState = createAiToolDisclosureState();
  const dispose = render(
    () =>
      createComponent(LocaleProvider, {
        locale: options.locale ?? "en",
        get children() {
          return createComponent(AiChatActionsProvider, {
            actions: {
              fileUrl: (path: string) => `/files?path=${encodeURIComponent(path)}`,
              onOpenFile: (path: string) => void options.opened?.push(path),
            },
            get children() {
              return createComponent(AiTurnView, {
                segment: () => ({
                  id: "ai-turn:turn:start",
                  turnId: "turn",
                  phase: "running",
                  layout: layoutAiTurn(blocks(), { phase: "running" }),
                  earlier: false,
                  duration: () => null,
                }),
                disclosureState,
              });
            },
          });
        },
      }),
    root,
  );
  const work = root.querySelector("details")!;
  open(work);
  return {
    work,
    cleanup: () => {
      dispose();
      root.remove();
    },
  };
};

if (isServer) test.skip("requires browser conditions and DOM transform", () => {});
else {
  test("a check's outcome replaces its running state in the same row, in words and with its own icon", async () => {
    const check = { id: "tool-check", kind: "tool" as const, callId: "check", name: "code_check", args: { id: "budget" } };
    const [blocks, setBlocks] = createSignal<AiTurnBlock[]>([{ ...check, status: "running" }]);
    const view = await mount(blocks, { locale: "de" });
    try {
      const row = view.work.querySelector(".ai-turn-steps details")!;
      expect(row.querySelector("strong")!.textContent).toBe("App-Prüfung");
      expect(row.querySelector("small")).toBeNull();

      setBlocks([
        {
          ...check,
          status: "completed",
          result: {
            passed: false,
            issues: [
              { severity: "error", kind: "layout", message: "Row is misaligned" },
              { severity: "error", kind: "contrast", message: "Low contrast" },
              { severity: "warning", kind: "layout", message: "Value is cut off" },
            ],
          },
        },
      ]);
      expect(view.work.querySelector(".ai-turn-steps details")).toBe(row);
      expect(row.querySelector("small")!.textContent).toBe("2 Befunde · 1 Warnung");
      expect(row.querySelector(".ti-alert-triangle")).not.toBeNull();

      setBlocks([{ ...check, callId: "check", status: "completed", result: { passed: true, issues: [] } }]);
      expect(row.querySelector("small")!.textContent).toBe("bestanden");
      expect(row.querySelector(".ti-circle-check")).not.toBeNull();
      expect(row.querySelector(".ti-alert-triangle")).toBeNull();
    } finally {
      view.cleanup();
    }
  });

  test("the screenshot thumbnail opens the chat file and keeps its box when the image fails", async () => {
    const opened: string[] = [];
    const path = "/checks/3f9a/phone.png";
    const viewed: AiTurnBlock = {
      id: "tool-view",
      kind: "tool",
      callId: "view",
      name: "view_image",
      args: { path },
      status: "completed",
      result: { path, mediaType: "image/png", description: "The phone view of the budget app." },
    };
    const view = await mount(() => [viewed], { opened });
    try {
      const step = view.work.querySelector<HTMLDetailsElement>(".ai-turn-steps details")!;
      expect(step.querySelector("img")).toBeNull();
      open(step);
      const thumbnail = step.querySelector<HTMLButtonElement>("button.ai-step-image")!;
      expect(thumbnail.getAttribute("aria-label")).toBe("Open image phone.png");
      const image = thumbnail.querySelector("img")!;
      expect(image.getAttribute("src")).toBe(`/files?path=${encodeURIComponent(path)}`);
      expect(image.getAttribute("alt")).toBe("The phone view of the budget app.");
      expect(image.getAttribute("loading")).toBe("lazy");

      thumbnail.click();
      expect(opened).toEqual([path]);

      image.dispatchEvent(new Event("error"));
      expect(step.querySelector("button.ai-step-image")).toBe(thumbnail);
      expect(thumbnail.querySelector("img")).toBeNull();
      expect(thumbnail.querySelector(".ti-photo-off")).not.toBeNull();
    } finally {
      view.cleanup();
    }
  });
}
