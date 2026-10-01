import { afterEach, describe, expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type { UploadOutcome, UploadQueue } from "../src/frontend/upload-queue";

type Transfer = {
  name: string;
  signal: AbortSignal;
  progress: (bytes: number) => void;
  resolve: (outcome: UploadOutcome) => void;
  reject: (error: Error) => void;
};

const transfers: Transfer[] = [];
let cleanup = () => {};
const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
/** Longer than the pause in which the batch action ignores a press after it changed meaning. */
const settleAction = () => wait(550);
const file = (path: string, size: number) => ({ file: new File([new Uint8Array(size)], path.split("/").at(-1)!), path });

/** A queue whose uploads wait until the test settles them, with its panel in the toast rail. */
async function mount() {
  const dom = createDomTestHarness();
  dom.root.className = "k2b-ui";
  dom.document.body.className = "k2b-ui";
  const { createUploadQueue } = await import("../src/frontend/upload-queue");
  const { UploadSurface } = await import("../src/frontend/UploadPanel");
  let queue!: UploadQueue<null>;
  const dispose = render(() => {
    queue = createUploadQueue<null>({
      reason: (error) => (error instanceof Error ? error.message : "failed"),
      upload: (_, item, { signal, onProgress }) =>
        new Promise((resolve, reject) => {
          transfers.push({ name: item.path, signal, progress: onProgress, resolve, reject });
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    });
    return <UploadSurface queue={queue} />;
  }, dom.root);
  const live: string[] = [];
  cleanup = () => {
    dispose();
    dom.cleanup();
  };
  const panel = () => dom.document.querySelector<HTMLElement>(".filesv2-upload");
  const text = (selector: string) => panel()?.querySelector(selector)?.textContent?.trim();
  const rows = () =>
    [...(panel()?.querySelectorAll<HTMLElement>(".filesv2-upload-row") ?? [])].map((row) => ({
      name: row.querySelector(".filesv2-upload-row__base")?.textContent,
      status: row.dataset.status,
    }));
  const add = async (...items: ReturnType<typeof file>[]) => {
    queue.add(null, { key: "home:Projects", label: "Projects" }, items);
    await wait();
    // Every message the polite region ends up saying, in order.
    const region = panel()?.querySelector('[role="status"]');
    if (region && !region.hasAttribute("data-observed")) {
      region.setAttribute("data-observed", "");
      new dom.window.MutationObserver(() => {
        const said = region.textContent?.trim();
        if (said) live.push(said);
      }).observe(region as unknown as Node, { childList: true, characterData: true, subtree: true });
    }
  };
  const current = () => transfers.at(-1)!;
  const finish = async (outcome: UploadOutcome = { status: "uploaded", path: current().name }) => {
    current().resolve(outcome);
    await wait();
  };
  const button = (label: string) =>
    [...(panel()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (entry) => entry.getAttribute("aria-label") === label || entry.textContent?.trim() === label,
    );
  return { dom, panel, text, rows, add, current, finish, button, live, queue: () => queue };
}

describe("upload panel", () => {
  if (isServer) {
    test.skip("runs in the browser-conditions test process", () => {});
    return;
  }
  afterEach(async () => {
    cleanup();
    transfers.length = 0;
    const { toast } = await import("@k2b/ui");
    toast.dismissAll();
  });

  test("bar, percent and count tell the same byte-weighted story", async () => {
    const ui = await mount();
    await ui.add(file("a.pdf", 10), file("b.pdf", 10), file("video.mp4", 80));
    const panel = ui.panel()!;
    expect(panel.closest("[data-k2b-toast-container]")).not.toBeNull();
    expect(ui.text(".filesv2-upload__title")).toBe("Uploading to “Projects”");
    expect(ui.text(".filesv2-upload__percent")).toBe("0%");
    expect(ui.text(".filesv2-upload__count")).toBe("0 of 3 files");
    expect(ui.button("Cancel upload")?.textContent?.trim()).toBe("Cancel");
    await ui.finish();
    await ui.finish();
    ui.current().progress(40);
    await wait();
    const bar = panel.querySelector<HTMLElement>('[role="progressbar"]')!;
    expect(ui.text(".filesv2-upload__percent")).toBe("60%");
    expect(bar.getAttribute("aria-valuenow")).toBe("60");
    expect(bar.getAttribute("aria-valuetext")).toBe("60%, 2 of 3 files uploaded");
    expect(panel.querySelector<HTMLElement>(".filesv2-upload__bar-done")!.style.width).toBe("60%");
    expect(ui.text(".filesv2-upload__count")).toBe("2 of 3 files");
    expect(ui.rows()).toEqual([
      { name: "a.pdf", status: "success" },
      { name: "b.pdf", status: "success" },
      { name: "video.mp4", status: "working" },
    ]);
    // The visible percent is decoration; the progress bar carries the value for assistive technology.
    expect(panel.querySelector(".filesv2-upload__percent")!.getAttribute("aria-hidden")).toBe("true");
    ui.current().progress(80);
    await wait();
    expect(ui.text(".filesv2-upload__percent")).toBe("99%");
    await ui.finish();
    expect(ui.text(".filesv2-upload__title")).toBe("Uploaded to “Projects”");
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
    expect(panel.dataset.expanded).toBe("false");
  });

  test("files added while running join the same list and the totals grow", async () => {
    const ui = await mount();
    await ui.add(file("a.pdf", 50), file("b.pdf", 50));
    await ui.finish();
    expect(ui.text(".filesv2-upload__percent")).toBe("50%");
    await ui.add(file("Scans/c.pdf", 100), file("Scans/d.pdf", 100));
    expect(ui.text(".filesv2-upload__count")).toBe("1 of 4 files");
    expect(ui.text(".filesv2-upload__percent")).toBe("16%");
    expect(ui.rows().map((row) => row.name)).toEqual(["a.pdf", "b.pdf", "c.pdf", "d.pdf"]);
    await wait(80);
    expect(ui.live.at(-1)).toBe("2 files added. Now 4 files in the upload.");
    // One panel for the whole batch.
    expect(ui.dom.document.querySelectorAll(".filesv2-upload")).toHaveLength(1);
  });

  test("a failed file stays in the list with its reason and can be retried there or all at once", async () => {
    const ui = await mount();
    await ui.add(file("a.jpg", 10), file("b.jpg", 10), file("c.jpg", 10));
    ui.current().reject(new Error("Connection lost"));
    await wait();
    const failed = ui.panel()!.querySelector<HTMLElement>('.filesv2-upload-row[data-status="failed"]')!;
    expect(failed.querySelector(".filesv2-upload-row__reason")?.textContent).toBe("Connection lost");
    expect(failed.textContent).toContain(", Failed");
    const retry = failed.querySelector<HTMLButtonElement>("button")!;
    expect(retry.getAttribute("aria-label")).toBe("Try again: a.jpg");
    expect(ui.text(".filesv2-upload__errors")).toBe("1 error");
    // No separate error toast per file.
    expect(ui.dom.document.querySelectorAll("[data-k2b-toast]:not([data-custom])")).toHaveLength(0);
    await ui.finish();
    ui.current().reject(new Error("Server did not answer"));
    await wait();
    expect(ui.text(".filesv2-upload__title")).toBe("2 files failed");
    expect(ui.text(".filesv2-upload__count")).toBe("1 of 3 files");
    expect(ui.panel()!.querySelector(".filesv2-upload__errors")).toBeNull();
    expect(ui.button("Upload 2 files again")?.textContent?.trim()).toBe("Try again");
    expect(ui.button("Dismiss notification")).toBeDefined();
    expect(ui.panel()!.dataset.expanded).toBe("true");
    retry.click();
    await wait();
    expect(ui.text(".filesv2-upload__title")).toBe("Uploading to “Projects”");
    expect(ui.current().name).toBe("a.jpg");
    await ui.finish();
    expect(ui.text(".filesv2-upload__title")).toBe("1 file failed");
    await settleAction();
    ui.button("Upload 1 file again")!.click();
    await wait();
    expect(ui.current().name).toBe("c.jpg");
    await ui.finish();
    expect(ui.text(".filesv2-upload__title")).toBe("Uploaded to “Projects”");
    expect(ui.text(".filesv2-upload__count")).toBe("3 of 3 files");
  });

  test("cancel stops the batch: finished files stay, the rest is marked cancelled", async () => {
    const ui = await mount();
    await ui.add(file("a", 1), file("b", 1), file("c", 1));
    await ui.finish();
    const running = ui.current();
    ui.button("Cancel upload")!.click();
    await wait();
    expect(running.signal.aborted).toBeTrue();
    expect(ui.text(".filesv2-upload__title")).toBe("Upload cancelled");
    expect(ui.rows().map((row) => row.status)).toEqual(["success", "cancelled", "cancelled"]);
    expect(ui.text(".filesv2-upload__count")).toBe("1 of 3 files");
    expect(ui.button("Cancel upload")).toBeUndefined();
    expect(transfers).toHaveLength(2);
  });

  test("files added after a cancel start a new batch that ends as a full success", async () => {
    const ui = await mount();
    await ui.add(file("a", 1), file("b", 1), file("c", 1));
    await ui.finish();
    ui.button("Cancel upload")!.click();
    await wait();
    await ui.add(file("d", 1));
    expect(ui.rows()).toEqual([{ name: "d", status: "working" }]);
    expect(ui.text(".filesv2-upload__count")).toBe("0 of 1 file");
    await ui.finish();
    expect(ui.text(".filesv2-upload__title")).toBe("Uploaded to “Projects”");
    expect(ui.text(".filesv2-upload__count")).toBe("1 of 1 file");
    expect(ui.dom.document.querySelectorAll(".filesv2-upload")).toHaveLength(1);
  });

  test("files uploaded before a cancel still refresh their folder when new files follow at once", async () => {
    const ui = await mount();
    const settled: (string | null)[] = [];
    ui.queue().onSettled((_, last) => settled.push(last));
    await ui.add(file("a", 1), file("b", 1));
    await ui.finish();
    // The cancelled upload is still unwinding when the next file arrives.
    ui.button("Cancel upload")!.click();
    ui.queue().add(null, { key: "home:Projects", label: "Projects" }, [file("d", 1)]);
    await wait();
    await ui.finish();
    expect(settled).toEqual(["a", "d"]);
  });

  test("a retry after a cancel ends cancelled, not as a success", async () => {
    const ui = await mount();
    await ui.add(file("a", 1), file("b", 1), file("c", 1));
    ui.current().reject(new Error("Connection lost"));
    await wait();
    ui.button("Cancel upload")!.click();
    await wait();
    expect(ui.rows().map((row) => row.status)).toEqual(["failed", "cancelled", "cancelled"]);
    await settleAction();
    ui.button("Upload 1 file again")!.click();
    await wait();
    await ui.finish();
    expect(ui.text(".filesv2-upload__title")).toBe("Upload cancelled");
    expect(ui.text(".filesv2-upload__count")).toBe("1 of 3 files");
    expect(ui.rows().map((row) => row.status)).toEqual(["success", "cancelled", "cancelled"]);
  });

  test("a double-click on Try again retries once and does not cancel what it retried", async () => {
    const ui = await mount();
    await ui.add(file("a", 1), file("b", 1), file("c", 1), file("d", 1));
    await ui.finish();
    ui.current().reject(new Error("Connection lost"));
    await wait();
    await ui.finish();
    ui.current().reject(new Error("Connection lost"));
    await wait();
    await settleAction();
    const action = ui.panel()!.querySelector<HTMLButtonElement>(".filesv2-upload__action")!;
    action.click();
    action.click();
    await wait();
    expect(ui.text(".filesv2-upload__title")).toBe("Uploading to “Projects”");
    expect(ui.current().signal.aborted).toBeFalse();
    expect(ui.rows().map((row) => row.status)).toEqual(["success", "working", "success", "pending"]);
  });

  test("cancelling a retry keeps the failures retryable", async () => {
    const ui = await mount();
    await ui.add(file("a", 1), file("b", 1));
    ui.current().reject(new Error("Connection lost"));
    await wait();
    await ui.finish();
    await settleAction();
    ui.button("Upload 1 file again")!.click();
    await wait();
    await settleAction();
    ui.button("Cancel upload")!.click();
    await wait();
    expect(ui.rows().map((row) => row.status)).toEqual(["failed", "success"]);
    expect(ui.panel()!.querySelector(".filesv2-upload-row__reason")?.textContent).toBe("Connection lost");
    expect(ui.button("Upload 1 file again")).toBeDefined();
  });

  test("a batch of files that all exist says nothing was uploaded", async () => {
    const ui = await mount();
    await ui.add(file("a", 1), file("b", 1));
    await ui.finish({ status: "skipped" });
    await ui.finish({ status: "skipped" });
    expect(ui.text(".filesv2-upload__title")).toBe("Nothing uploaded");
    expect(ui.text(".filesv2-upload__count")).toBe("All 2 files already exist");
    await wait(100);
    expect(ui.live.at(-1)).toBe("Nothing uploaded. All 2 files already exist.");
  });

  test("when the batch action leaves with focus on it, focus moves to the close button", async () => {
    const ui = await mount();
    await ui.add(file("a", 1), file("b", 1));
    ui.button("Cancel upload")!.focus();
    ui.button("Cancel upload")!.click();
    await wait();
    expect(ui.dom.document.activeElement?.getAttribute("aria-label")).toBe("Dismiss notification");
    cleanup();
    transfers.length = 0;

    const done = await mount();
    await done.add(file("a", 1));
    done.button("Cancel upload")!.focus();
    await done.finish();
    expect(done.dom.document.activeElement?.getAttribute("aria-label")).toBe("Dismiss notification");
  });

  test("a row retry by keyboard keeps focus in the list; by pointer it leaves focus alone", async () => {
    const ui = await mount();
    await ui.add(file("a", 1), file("b", 1), file("c", 1));
    ui.current().reject(new Error("Connection lost"));
    await wait();
    ui.current().reject(new Error("Connection lost"));
    await wait();
    const retry = (name: string, detail: number) =>
      ui
        .panel()!
        .querySelector<HTMLButtonElement>(`button[aria-label="Try again: ${name}"]`)!
        .dispatchEvent(new ui.dom.window.MouseEvent("click", { bubbles: true, detail }) as unknown as Event);
    retry("a", 1);
    await wait();
    expect(ui.dom.document.activeElement?.classList.contains("filesv2-upload__scroll")).toBeFalse();
    retry("b", 0);
    await wait();
    expect(ui.dom.document.activeElement?.classList.contains("filesv2-upload__scroll")).toBeTrue();
  });

  test("the live region says milestones, failures and the summary, never single percent steps", async () => {
    const ui = await mount();
    await ui.add(file("big.bin", 100), file("small.bin", 100));
    for (let bytes = 1; bytes <= 100; bytes++) {
      ui.current().progress(bytes);
      await wait(5);
    }
    await wait(100);
    await ui.finish();
    ui.current().reject(new Error("Connection lost"));
    await wait(100);
    expect(ui.live).toEqual([
      "Upload started: 2 files.",
      "25% uploaded, 0 of 2 files.",
      "50% uploaded, 0 of 2 files.",
      "Upload finished. 1 of 2 files uploaded, 1 failed.",
    ]);
  });

  test("names show their folder only when two files in the batch share them; screen readers always get the path", async () => {
    const ui = await mount();
    await ui.add(file("Photos/IMG_1.jpg", 1), file("Backup/IMG_1.jpg", 1), file("Scans/page.pdf", 1));
    const rows = [...ui.panel()!.querySelectorAll<HTMLElement>(".filesv2-upload-row")];
    expect(rows.map((row) => row.querySelector(".filesv2-upload-row__folder")?.textContent ?? null)).toEqual(["Photos/", "Backup/", null]);
    expect(rows[2]!.querySelector(".filesv2-upload-row__name")!.textContent).toBe("Scans/page.pdf, Waiting");
    expect(rows[0]!.querySelector(".filesv2-upload-row__name")!.textContent).toBe("Photos/IMG_1.jpg, Uploading");
  });

  test("a batch of thousands of files renders only the rows near the view", async () => {
    const ui = await mount();
    await ui.add(...Array.from({ length: 2000 }, (_, index) => file(`Archive/scan-${index}.pdf`, 1)));
    const rows = ui.panel()!.querySelectorAll<HTMLElement>(".filesv2-upload-row");
    expect(rows.length).toBeLessThan(20);
    expect(rows[0]!.getAttribute("aria-setsize")).toBe("2000");
    expect(ui.text(".filesv2-upload__count")).toBe("0 of 2000 files");
  });

  test("a quiet success leaves after five seconds, not while the pointer rests on it", async () => {
    const ui = await mount();
    await ui.add(file("a.pdf", 1));
    await ui.finish();
    const panel = ui.panel()!;
    panel.dispatchEvent(new ui.dom.window.Event("pointerenter") as unknown as Event);
    await wait(5300);
    expect(panel.isConnected).toBeTrue();
    panel.dispatchEvent(new ui.dom.window.Event("pointerleave") as unknown as Event);
    await wait(5300);
    expect(ui.panel()).toBeNull();
    expect(ui.queue().batch.rows).toHaveLength(0);
  }, 15_000);
});
