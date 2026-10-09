import { expect, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { FileProviderCaller, FileProviderSource } from "./file-providers";

const domTest = isServer ? test.skip : test;

const drive: FileProviderSource = {
  appId: "drive",
  name: "Drive",
  icon: "ti ti-folders",
  list: "folder.list",
  read: "file.read",
  maxBytes: 1_000,
  save: { id: "file.save", maxBytes: 1_000 },
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const json = (body: unknown, status = 200) => Response.json(body, { status });

/** One provider: its root lists a base that cannot take files, inside it a writable folder with a taken name. */
const provider = () => {
  const stored = new Map<string, string>([["docs/report.pdf", "old"]]);
  const saves: { name: string; key: string | null }[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    const headers = new Headers(init?.headers);
    if (path.endsWith("/streams/write")) {
      const target = headers.get("x-cloud-stream-id")!;
      stored.set(target, await new Response(init?.body).text());
      const name = target.split("/").at(-1)!;
      return json({ data: { file: { id: target, name, size: 5 } }, links: [{ rel: "open", href: "/app/drive?path=docs" }] });
    }
    const { input } = JSON.parse(String(init?.body)) as { input: Record<string, string | number> };
    if (path.endsWith("/folder.list")) {
      if (input.parent === undefined)
        return json({ data: { writable: false, items: [{ kind: "folder", id: "home", name: "Home" }], next: null } });
      if (input.parent === "home")
        return json({
          data: {
            writable: false,
            items: [
              { kind: "folder", id: "docs", name: "Docs" },
              { kind: "file", id: "x", name: "notes.txt", size: 4 },
            ],
            next: null,
          },
        });
      return json({ data: { writable: true, items: [{ kind: "file", id: "r", name: "report.pdf", size: 3 }], next: null } });
    }
    saves.push({ name: String(input.name), key: headers.get("idempotency-key") });
    const target = `${input.parent}/${input.name}`;
    if (stored.has(target)) return json({ code: "FILE_NAME_CONFLICT", message: "Taken" }, 409);
    return json({
      data: {},
      stream: {
        id: target,
        direction: "write",
        name: input.name,
        mediaType: input.mediaType,
        size: input.size,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
  };
  return { stored, saves, fetch };
};

const open = async (dom: ReturnType<typeof createDomTestHarness>, providers: FileProviderSource[], fetch?: FileProviderCaller["fetch"]) => {
  const { createFileSaving } = await import("./save-files");
  const { createProviderList } = await import("./provider-list");
  const list = createProviderList(async () => providers);
  const saving = createFileSaving(list, () => ({ locale: "en", fetch }));
  const result = saving.saveFiles([{ name: "report.pdf", content: new Blob(["hello"], { type: "application/pdf" }) }]);
  await settle();
  await settle();
  const dialog = () => dom.document.querySelector("dialog[open] .cloud-file-chooser");
  const button = (label: string) =>
    [...(dialog()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((element) => element.textContent?.trim() === label);
  const row = (name: string) =>
    [...(dialog()?.querySelectorAll<HTMLElement>('[role="gridcell"]') ?? [])].find((cell) => cell.textContent?.includes(name));
  const status = () => dialog()?.querySelector(".cloud-file-chooser__status")?.textContent ?? "";
  return { result, dialog, button, row, status, saving };
};

domTest("without an app that stores files, the dialog says so calmly and saves nothing", async () => {
  const dom = createDomTestHarness();
  try {
    const readOnly = { ...drive, save: undefined };
    const { result, dialog, button } = await open(dom, [readOnly]);
    expect(dialog()?.textContent).toContain("No app can store files for you");
    expect(button("Save")?.disabled).toBe(true);
    button("Cancel")?.click();
    expect(await result).toEqual([]);
  } finally {
    dom.cleanup();
  }
});

domTest("one app opens straight into its folders; Save waits for a writable folder and a taken name asks for another", async () => {
  const dom = createDomTestHarness();
  const { stored, saves, fetch } = provider();
  try {
    const { result, dialog, button, row, status, saving } = await open(dom, [drive], fetch);
    expect(saving.label("en")).toBe("Save to Drive");
    expect(saving.label("de", { name: "a.pdf" })).toBe("a.pdf in Drive speichern");
    // No source list: the path starts at Drive, and its root cannot take files.
    expect(dialog()?.querySelector(".cloud-file-chooser__crumbs")?.textContent).not.toContain("Sources");
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Save “report.pdf”");
    expect(status()).toBe("Choose a folder");
    expect(button("Save")?.disabled).toBe(true);

    row("Home")?.click();
    await settle();
    expect(status()).toBe("You cannot save in this folder");
    // Files are shown, so taken names are visible, but only folders open.
    expect(row("notes.txt")?.getAttribute("aria-disabled")).toBe("true");
    row("Docs")?.click();
    await settle();
    expect(status()).toBe("Saves to Docs");

    button("Save")?.click();
    for (let attempt = 0; attempt < 20 && !dialog()?.querySelector(".cloud-file-saver__rename"); attempt++) await settle();
    const input = dialog()?.querySelector<HTMLInputElement>(".cloud-file-saver__rename input");
    expect(input?.value).toBe("report (2).pdf");
    expect(dialog()?.textContent).toContain("This name is taken");
    expect(stored.get("docs/report.pdf")).toBe("old");

    [...(dialog()?.querySelectorAll<HTMLButtonElement>(".cloud-file-saver__rename button") ?? [])][0]?.click();
    expect(await result).toEqual([{ name: "report (2).pdf", app: "Drive", href: "/app/drive?path=docs" }]);
    expect(stored.get("docs/report (2).pdf")).toBe("hello");
    // The new name got a new key; the taken one never became a second file.
    expect(saves.map((save) => save.name)).toEqual(["report.pdf", "report (2).pdf"]);
    expect(saves[0]?.key).not.toBe(saves[1]?.key);
    expect(dom.document.body.textContent).toContain("Saved report (2).pdf to Drive");
  } finally {
    dom.cleanup();
  }
});

domTest("several apps start at the list of places to save, and Cancel resolves nothing", async () => {
  const dom = createDomTestHarness();
  try {
    const vault = { ...drive, appId: "vault", name: "Vault" };
    const { result, row, saving, button } = await open(dom, [drive, vault]);
    expect(saving.label("en", { all: true })).toBe("Save all to…");
    expect(row("Drive")).toBeDefined();
    expect(row("Vault")).toBeDefined();
    expect(button("Save")?.disabled).toBe(true);
    button("Cancel")?.click();
    expect(await result).toEqual([]);
  } finally {
    dom.cleanup();
  }
});
