import { afterEach, describe, expect, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import { encodeNotePdfOmissions, NOTE_PDF_OMISSIONS_HEADER, type NotePdfOmission } from "../../../../lib/pdf-omissions";

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

describe("the note PDF dialog", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const setup = async (answer: (signal: AbortSignal | undefined) => Promise<Response>) => {
    const dom = createDomTestHarness();
    dom.document.documentElement.lang = "en";
    dom.root.className = "k2b-ui";
    const downloads: string[] = [];
    Object.assign(dom.window.URL, { createObjectURL: () => "blob:pdf", revokeObjectURL: () => {} });
    dom.window.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    };
    let signal: AbortSignal | undefined;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return answer(signal);
    }) as typeof fetch;
    const { dialogCore } = await import("@k2b/ui");
    const { openNotePdfDialog } = await import("./NotePdfDialog");
    let closed = false;
    void openNotePdfDialog({ notebookId: "book01", noteId: "note01", noteTitle: "Trip plan", markdown: "# Trip" }).then(() => {
      closed = true;
    });
    await tick();
    // A button's visible name, without the hidden label that only reserves its width.
    const name = (element: Element) => {
      const copy = element.cloneNode(true) as Element;
      for (const hidden of Array.from(copy.querySelectorAll('[aria-hidden="true"]'))) hidden.remove();
      return copy.textContent?.trim();
    };
    const button = (label: string) => Array.from(dom.document.querySelectorAll("button")).find((element) => name(element) === label);
    return {
      dom,
      downloads,
      button,
      signal: () => signal,
      closed: () => closed,
      report: () => dom.document.querySelector("[data-pdf-omissions]"),
      list: () => Array.from(dom.document.querySelectorAll("[data-pdf-omission-list] li")).map((item) => item.textContent ?? ""),
      cleanup: () => {
        while (dialogCore.isOpen()) dialogCore.close();
        dom.cleanup();
      },
    };
  };

  const pdf = (headers: Record<string, string> = {}) =>
    new Response(new Blob(["%PDF-test"], { type: "application/pdf" }), { headers: { "Content-Type": "application/pdf", ...headers } });

  test("downloads and closes as before when the PDF leaves nothing out", async () => {
    const page = await setup(async () => pdf());
    try {
      page.button("Download PDF")!.click();
      await tick();
      expect(page.downloads).toEqual(["Trip plan.pdf"]);
      expect(page.closed()).toBe(true);
      expect(page.report()).toBeNull();
    } finally {
      page.cleanup();
    }
  });

  test("downloads, stays open and lists what the PDF left out from the header", async () => {
    const omissions: NotePdfOmission[] = [
      { code: "not_rendered", kind: "image", label: "Floor plan" },
      { code: "invalid_block", kind: "data", label: "@budget" },
      { code: "not_rendered", kind: "diagram", label: "" },
    ];
    const header = encodeNotePdfOmissions(omissions)!;
    const page = await setup(async () => pdf({ [NOTE_PDF_OMISSIONS_HEADER]: header }));
    try {
      // The live region exists before the report arrives, so the report is announced.
      const live = page.dom.document.querySelector('[role="status"][aria-live="polite"]');
      expect(live?.textContent).toBe("");
      page.button("Download PDF")!.click();
      await tick();
      expect(page.downloads).toEqual(["Trip plan.pdf"]);
      expect(page.closed()).toBe(false);
      expect(live?.textContent).toBe("3 items are not in the PDF.");
      const report = page.report();
      expect(report?.getAttribute("data-tone")).toBe("warning");
      expect(report?.textContent).toContain("3 items are not in the PDF.");
      // The data notice keeps sharing the summary's cell, so the summary takes no new room.
      const dataNotice = report?.parentElement?.querySelector<HTMLElement>('[aria-hidden="true"].k2b-inline-guidance');
      expect(dataNotice?.style.visibility).toBe("hidden");
      expect(dataNotice?.textContent).toContain("processed in memory");
      const details = page.button("Details")!;
      expect(details.getAttribute("aria-expanded")).toBe("false");
      expect(page.list()).toEqual([]);
      details.click();
      await tick();
      expect(details.getAttribute("aria-expanded")).toBe("true");
      const items = page.list();
      expect(items).toHaveLength(4);
      expect(items[0]).toContain("Image");
      expect(items[0]).toContain("Floor plan");
      expect(items[0]).toContain("Open the note to see the image.");
      expect(items[1]).toContain("@budget");
      expect(items[1]).toContain("It contains an error.");
      expect(items[3]).toBe("The PDF marks each one in place.");
      expect(page.dom.document.getElementById(details.getAttribute("aria-controls")!)).not.toBeNull();
      expect(page.button("Close")).toBeDefined();
    } finally {
      page.cleanup();
    }
  });

  test("says how many more the header could not carry", async () => {
    const value = encodeNotePdfOmissions(
      Array.from({ length: 200 }, (_, index) => ({
        code: "invalid_block" as const,
        kind: "chart" as const,
        label: `${index} `.repeat(30),
      })),
    )!;
    const page = await setup(async () => pdf({ [NOTE_PDF_OMISSIONS_HEADER]: value }));
    try {
      page.button("Download PDF")!.click();
      await tick();
      expect(page.report()!.textContent).toContain("200 items are not in the PDF.");
      page.button("Details")!.click();
      await tick();
      const items = page.list();
      const shown = items.length - 1;
      expect(shown).toBeGreaterThan(0);
      expect(items.at(-1)).toBe(`and ${200 - shown} more, marked in the PDF`);
    } finally {
      page.cleanup();
    }
  });

  test("an unreadable header downloads and closes like a complete PDF", async () => {
    const page = await setup(async () => pdf({ [NOTE_PDF_OMISSIONS_HEADER]: "%%%" }));
    try {
      page.button("Download PDF")!.click();
      await tick();
      expect(page.downloads).toEqual(["Trip plan.pdf"]);
      expect(page.closed()).toBe(true);
    } finally {
      page.cleanup();
    }
  });

  test("cancel still aborts a running export and downloads nothing", async () => {
    const page = await setup(
      (signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    );
    try {
      page.button("Download PDF")!.click();
      await tick();
      expect(page.signal()?.aborted).toBe(false);
      page.button("Cancel")!.click();
      await tick();
      expect(page.signal()?.aborted).toBe(true);
      expect(page.closed()).toBe(true);
      expect(page.downloads).toEqual([]);
    } finally {
      page.cleanup();
    }
  });
});
