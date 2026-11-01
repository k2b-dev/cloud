import { afterEach, expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

// Closing a document goes back exactly once, also when browser Back answered its question first.
const base = {
  id: "team",
  name: "Nordlicht",
  area: "cloud" as const,
  kind: "groups" as const,
  status: "existing" as const,
  reason: null,
  indexEnabled: false,
  versioningEnabled: false,
};
const bases = { items: [base], issues: [], editor: null };
const entry = { name: "protokoll.md", path: "Einkauf/protokoll.md", directory: false, size: 5, modified: "2026-10-20T08:00:00Z" };
const launch = { kind: "markdown" as const, base, entry, url: "https://files.example.test/direct", managed: true, canWrite: true };
if (!isServer)
  mock.module("../src/api/client", () => ({
    apiClient: {
      bases: {
        $get: async () => Response.json(bases),
        ":baseId": {
          entries: {
            $get: async (input: { query: { path: string } }) => Response.json({ base, path: input.query.path, items: [entry], next: null }),
          },
          editor: { $post: async () => Response.json(launch) },
        },
      },
    },
  }));
const settle = async () => {
  for (let round = 0; round < 8; round++) await new Promise((resolve) => setTimeout(resolve, 0));
};
let cleanup = () => {};
afterEach(() => cleanup());

test("a Markdown close whose question browser Back answered first goes back only once", async () => {
  if (isServer) return;
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => new Response("hello", { headers: { etag: '"r1"' } }), {
    preconnect: originalFetch.preconnect,
  });
  const { default: Workspace } = await import("../src/frontend/Workspace.island");
  const from = "/app/filesv2?base=team&path=Einkauf&sort=size";
  const edit = "/app/filesv2?base=team&path=Einkauf&file=Einkauf%2Fprotokoll.md&view=edit";
  dom.window.history.replaceState(null, "", "/app/filesv2?base=team");
  dom.window.history.pushState(null, "", from);
  dom.window.history.pushState({ "filesv2:openedFrom": from }, "", edit);
  const dispose = render(
    () =>
      createComponent(Workspace, {
        initial: { source: edit, bases, selectedId: base.id, directory: null, errorCode: null, editor: launch },
      }),
    dom.root,
  );
  cleanup = () => {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  };
  await settle();
  const editor = dom.root.querySelector<HTMLTextAreaElement>("textarea")!;
  editor.value = "draft";
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  [...dom.root.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button')].at(-1)!.click();
  await settle();
  expect(dom.document.querySelectorAll("dialog[open]")).toHaveLength(1);
  dom.window.history.back();
  await settle();
  [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Confirm")!.click();
  await settle();
  expect(`${dom.window.location.pathname}${dom.window.location.search}`).toBe(from);
  expect(dom.document.querySelectorAll("dialog[open]")).toHaveLength(0);
});
