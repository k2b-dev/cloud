import { afterEach, beforeEach, describe, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import type { AccessEntry } from "@k2b/cloud/contracts";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { ContactBook } from "../../service";

/** Opens a row's level menu and picks a level, as a person would. */
const chooseLevel = (row: Element, level: string) => {
  row.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!.click();
  Array.from(row.querySelectorAll<HTMLElement>('[role="radio"]'))
    .find((option) => option.textContent?.includes(level))!
    .click();
};

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

  test("access changes save together in the dialog; a half-failed, discarded save still reloads once", async () => {
    const dom = createDomTestHarness();
    dom.document.documentElement.lang = "en";
    delegateEvents(["click", "input"], dom.document);
    const { prompts } = await import("@k2b/ui");
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(true);
    const entry = (id: string, name: string, permission: AccessEntry["permission"]): AccessEntry => ({
      id,
      principal: { type: "user", userId: `user-${id}` },
      permission,
      displayName: name,
      createdAt: now,
    });
    const mia = entry("mia", "Mia Hoffmann", "admin");
    const lea = entry("lea", "Lea Schmitt", "read");
    const ben = entry("ben", "Ben Albers", "read");
    const writes: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        writes.push(`${init?.method} ${url.split("/access/")[1]}`);
        if (init?.method === "DELETE") return Response.json({ message: "offline" }, { status: 503 });
        return new Response(null, { status: 204 });
      },
      { preconnect: originalFetch.preconnect },
    );
    const onWorkspaceChange = mock(() => {});
    const onReconcile = mock(async () => {});
    const dialog = () => dom.document.querySelector<HTMLElement>('[role="dialog"]');
    const button = (text: string) =>
      Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === text);
    const row = (name: string) => Array.from(dialog()!.querySelectorAll("li")).find((item) => item.textContent?.includes(name))!;
    const waitFor = async (condition: () => boolean, label: string) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (condition()) return;
        await Bun.sleep(10);
      }
      throw new Error(`Timed out waiting for ${label}`);
    };
    let dispose: (() => void) | undefined;
    try {
      dispose = render(
        () => (
          <BookSettingsForm
            context={() => ({ book, accessEntries: [mia, lea, ben], apiKeys: [], tags: [] })}
            initialTab="access"
            onClose={() => {}}
            onDeleted={() => {}}
            onWorkspaceChange={onWorkspaceChange}
            onReconcile={onReconcile}
          />
        ),
        dom.root,
      );
      button("Edit access")!.click();
      await waitFor(() => dialog()?.textContent?.includes("Access to Suppliers") === true, "the access dialog");
      chooseLevel(row("Lea Schmitt"), "Edit");
      row("Ben Albers").querySelector<HTMLButtonElement>('button[aria-label="Remove Ben Albers"]')!.click();
      await waitFor(() => dialog()?.textContent?.includes("2 changes") === true, "two changes");
      expect(writes).toEqual([]);
      button("Save")!.click();
      await waitFor(() => !!dialog()?.querySelector('[role="alert"]'), "the failed removal");
      expect(writes).toEqual(["PATCH lea", "DELETE ben"]);
      // Each change does not reload the settings on its own; the dialog saves them together.
      expect(onReconcile).not.toHaveBeenCalled();
      button("Cancel")!.click();
      await waitFor(() => onReconcile.mock.calls.length === 1, "one reload after the dialog");
      expect(dialog()).toBeNull();
      expect(onWorkspaceChange).toHaveBeenCalledTimes(1);
    } finally {
      dispose?.();
      confirm.mockRestore();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

  test("a form closed while Edit access retries its reload says nothing over the next page", async () => {
    const dom = createDomTestHarness();
    dom.document.documentElement.lang = "en";
    delegateEvents(["click", "input"], dom.document);
    const { prompts } = await import("@k2b/ui");
    const error = spyOn(prompts, "error").mockResolvedValue(undefined);
    const lea: AccessEntry = {
      id: "lea",
      principal: { type: "user", userId: "user-lea" },
      permission: "read",
      displayName: "Lea Schmitt",
      createdAt: now,
    };
    const mia: AccessEntry = {
      ...lea,
      id: "mia",
      principal: { type: "user", userId: "user-mia" },
      permission: "admin",
      displayName: "Mia",
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async () => new Response(null, { status: 204 }), { preconnect: originalFetch.preconnect });
    const retry = Promise.withResolvers<void>();
    let reloads = 0;
    const onReconcile = mock(async () => {
      reloads += 1;
      if (reloads === 1) throw new Error("offline");
      await retry.promise;
    });
    const dialog = () => dom.document.querySelector<HTMLElement>('[role="dialog"]');
    const button = (text: string) =>
      Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === text);
    const waitFor = async (condition: () => boolean, label: string) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (condition()) return;
        await Bun.sleep(10);
      }
      throw new Error(`Timed out waiting for ${label}`);
    };
    let dispose: (() => void) | undefined;
    try {
      dispose = render(
        () => (
          <BookSettingsForm
            context={() => ({ book, accessEntries: [mia, lea], apiKeys: [], tags: [] })}
            initialTab="access"
            onClose={() => {}}
            onDeleted={() => {}}
            onWorkspaceChange={() => {}}
            onReconcile={onReconcile}
          />
        ),
        dom.root,
      );
      button("Edit access")!.click();
      await waitFor(() => dialog()?.textContent?.includes("Lea Schmitt") === true, "the access dialog");
      const row = Array.from(dialog()!.querySelectorAll("li")).find((item) => item.textContent?.includes("Lea Schmitt"))!;
      chooseLevel(row, "Edit");
      await waitFor(() => dialog()?.textContent?.includes("1 change") === true, "one change");
      button("Save")!.click();
      await waitFor(() => reloads === 1 && !dialog(), "the failed reload");
      await waitFor(() => dom.root.textContent?.includes("could not be reloaded") === true, "the reload warning");
      button("Edit access")!.click();
      await waitFor(() => reloads === 2, "the retried reload");
      dispose();
      dispose = undefined;
      retry.resolve();
      await Bun.sleep(30);
      expect(error).not.toHaveBeenCalled();
      expect(dialog()).toBeNull();
    } finally {
      dispose?.();
      error.mockRestore();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
});
