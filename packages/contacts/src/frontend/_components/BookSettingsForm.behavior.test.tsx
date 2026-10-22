import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { ContactBook } from "../../service";

const load = async () => {
  const dom = createDomTestHarness();
  try {
    return (await import("./BookSettingsForm")).default;
  } finally {
    dom.cleanup();
  }
};
const BookSettingsForm = isServer ? undefined : await load();

const now = "2026-10-17T12:00:00.000Z";
const book: ContactBook = {
  id: "book-1",
  name: "Suppliers",
  description: "External suppliers",
  createdAt: now,
  updatedAt: now,
};

describe("Contact book settings reconciliation", () => {
  if (!BookSettingsForm) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  beforeEach(() => setSystemTime(new Date(now)));
  afterEach(() => setSystemTime());

  test("keeps a failed settings reload visible in shared warning guidance until retry succeeds", async () => {
    const dom = createDomTestHarness();
    delegateEvents(["click", "input"], dom.document);
    const updatedBook = { ...book, name: "Team suppliers" };
    let reloads = 0;
    const onReconcile = mock(async () => {
      reloads += 1;
      if (reloads === 1) throw new Error("offline");
    });
    const originalFetch = globalThis.fetch;
    const requests: { url: string; method: string | undefined; body: unknown }[] = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (init?.method !== "PATCH" || !url.endsWith("/api/contacts/books/book-1")) {
          throw new Error(`Unexpected request: ${init?.method} ${url}`);
        }
        requests.push({ url, method: init.method, body: JSON.parse(String(init.body)) });
        return Response.json(updatedBook);
      },
      { preconnect: originalFetch.preconnect },
    );
    let dispose: (() => void) | undefined;
    const guidance = () => dom.root.querySelector('.k2b-inline-guidance[data-tone="warning"]');
    const waitFor = async (condition: () => boolean) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (condition()) return;
        await Bun.sleep(10);
      }
      throw new Error("Timed out waiting for settings reconciliation");
    };
    try {
      dispose = render(
        () => (
          <BookSettingsForm
            context={() => ({ book, accessEntries: [], apiKeys: [], tags: [] })}
            onClose={() => {}}
            onDeleted={() => {}}
            onWorkspaceChange={() => {}}
            onReconcile={onReconcile}
          />
        ),
        dom.root,
      );
      expect(guidance()).toBeNull();
      const name = dom.root.querySelector<HTMLInputElement>('input[aria-label="Book name"]')!;
      name.value = updatedBook.name;
      name.dispatchEvent(new Event("input", { bubbles: true }));
      const save = Array.from(dom.root.querySelectorAll<HTMLButtonElement>(".k2b-settings__footer button")).find(
        (button) => button.textContent?.trim() === "Save changes",
      )!;
      expect(save).toBeDefined();
      expect(save.disabled).toBe(false);
      save.click();
      await waitFor(() => reloads === 1);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.body).toEqual({ name: updatedBook.name, description: book.description });
      expect(onReconcile).toHaveBeenCalledTimes(1);
      await waitFor(() => guidance() !== null);
      expect(guidance()?.textContent).toContain("The change was saved, but contact book settings could not be reloaded.");
      const retry = Array.from(guidance()!.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent?.trim() === "Retry reload",
      )!;
      expect(retry).toBeDefined();
      retry.click();
      await waitFor(() => onReconcile.mock.calls.length === 2 && guidance() === null);
      expect(onReconcile).toHaveBeenCalledTimes(2);
      expect(guidance()).toBeNull();
      expect(requests).toHaveLength(1);
    } finally {
      dispose?.();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
});
