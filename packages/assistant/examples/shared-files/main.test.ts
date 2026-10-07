import { expect, test } from "bun:test";
import { createDomTestHarness } from "../../../ui/test/dom";
import { html } from "../../src/artifacts/runtime/lib";

const page = await Bun.file(new URL("./index.html", import.meta.url)).text();
const script = await Bun.file(new URL("./app.js", import.meta.url)).text();
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** Runs the app's real HTML and module against fake capabilities. */
async function harness(deny = false) {
  const dom = createDomTestHarness();
  dom.root.innerHTML = page;
  const calls: [string, unknown][] = [];
  const saved: { content: File; name: string }[] = [];
  const file = new File(["pdf"], "invoice.pdf", { type: "application/pdf" });
  const cloud = {
    html,
    kv: { get: async () => ({ gridsTemplateId: "Tpl001", filesBaseId: "base" }) },
    download: async (name: string, content: File) => saved.push({ content, name }),
    capabilities: {
      run: async (name: string, input: unknown) => {
        calls.push([name, input]);
        if (name === "grids.document.list")
          return { data: [{ id: "same-id", filename: "invoice.pdf" }], page: { hasMore: true, nextCursor: "g-next" } };
        if (name === "filesv2.entry.list") return { data: { items: [{ ref: { id: "same-id" }, name: "contract.pdf" }], next: null } };
        if (deny) throw new Error("Access denied");
        return { stream: { id: "current-run" } };
      },
      streams: {
        read: async (stream: { id: string }) => {
          expect(stream.id).toBe("current-run");
          return file;
        },
      },
    },
  };
  const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<void>;
  await new AsyncFunction("cloud", "document", script)(cloud, dom.window.document);
  const click = async (selector: string) => {
    dom.root.querySelector<HTMLButtonElement>(selector)!.click();
    await settle();
  };
  const select = (index: number) => {
    const radio = dom.root.querySelectorAll<HTMLInputElement>('input[name="file"]')[index]!;
    radio.checked = true;
    radio.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  };
  return {
    calls,
    saved,
    click,
    select,
    keys: () => [...dom.root.querySelectorAll<HTMLInputElement>('input[name="file"]')].map((input) => input.value),
    status: () => dom.root.querySelector("#status")!.textContent,
    cleanup: () => dom.cleanup(),
  };
}

test("combines source-local identities, paginates explicitly and downloads through each source's stream", async () => {
  const app = await harness();
  try {
    expect(app.keys()).toEqual(["grids:same-id", "files:same-id"]);
    for (const index of [0, 1]) {
      app.select(index);
      await app.click("#download");
    }
    expect(app.calls.slice(2).map((call) => call[0])).toEqual(["grids.document.content.read", "filesv2.content.read"]);
    expect(app.saved).toHaveLength(2);
    expect(app.saved[0]!.name).toBe("invoice.pdf");
    await app.click("#next-grids");
    expect(app.calls.at(-1)).toEqual(["grids.document.list", { templateId: "Tpl001", limit: 100, cursor: "g-next" }]);
    const count = app.calls.length;
    await app.click("#next-files");
    expect(app.calls).toHaveLength(count);
    expect(app.status()).toBe("No further page for this source.");
  } finally {
    app.cleanup();
  }
});

test("denied reads never save bytes and explain the failure", async () => {
  const app = await harness(true);
  try {
    app.select(0);
    await app.click("#download");
    expect(app.saved).toHaveLength(0);
    expect(app.status()).toBe("Download failed: Access denied");
  } finally {
    app.cleanup();
  }
});
