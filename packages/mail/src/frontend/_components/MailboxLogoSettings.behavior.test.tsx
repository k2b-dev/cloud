import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../ui/test/dom";
import type { MailboxComposeLogo } from "../../contracts";

// The UI browser build needs a document during module evaluation. Keep the cold transform outside the test timeout.
const load = async () => {
  const dom = createDomTestHarness();
  try {
    const [{ default: MailboxLogoSettings }, { dialogCore, LocaleProvider, toast }] = await Promise.all([
      import("./MailboxLogoSettings"),
      import("@k2b/ui"),
    ]);
    return { MailboxLogoSettings, dialogCore, LocaleProvider, toast };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

type Logo = NonNullable<MailboxComposeLogo["logo"]>;
const endpoint = "/api/mail/mailboxes/Box001/compose-logo";
// Real, tiny PNGs (3 × 2 and 4 × 1). Their bytes and all fixture timestamps are fixed.
const content = "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAEElEQVR4nGNgaPj/H46ROQC4Cg71MgUCWAAAAABJRU5ErkJggg==";
const replacementContent = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAABCAYAAAD5PA/NAAAAD0lEQVR4nGP438DwHxkDAFXNCfkaFx1aAAAAAElFTkSuQmCC";
const storedLogo: Logo = {
  contentType: "image/png",
  pixelWidth: 3,
  pixelHeight: 2,
  displayWidth: 200,
  altText: "Company logo",
  byteLength: 73,
  sha256: "8660568ade69210635372823ae16b748949a1e43afc11d1c74f7e955d6e8bedc",
  dataUrl: `data:image/png;base64,${content}`,
  createdAt: "2026-10-11T10:00:00.000Z",
};

const waitFor = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 150 && !condition(); attempt++) await Bun.sleep(10);
  expect(condition()).toBe(true);
};

describe("Mailbox logo settings", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }
  const { MailboxLogoSettings, dialogCore, LocaleProvider, toast } = modules!;
  const originalFetch = globalThis.fetch;
  let dom: DomTestHarness;
  let dispose = () => {};
  let initialLogo: Logo | null;
  let getResponse: () => Response;
  let putResponse: (request: Request) => Response | Promise<Response>;
  let requests: Array<{ method: string; path: string; body: unknown }>;
  let unexpected: string[];

  beforeEach(() => {
    dom = createDomTestHarness();
    delegateEvents(["click", "input", "change", "focusin", "focusout"], dom.document);
    dispose = () => {};
    initialLogo = null;
    getResponse = () => Response.json({ logo: initialLogo });
    putResponse = () => Response.json({ logo: storedLogo });
    requests = [];
    unexpected = [];
    const fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), "http://localhost"), init);
        const path = new URL(request.url).pathname;
        requests.push({ method: request.method, path, body: request.method === "PUT" ? await request.json() : null });
        if (path === endpoint) {
          if (request.method === "GET") return getResponse();
          if (request.method === "PUT") return putResponse(request);
          if (request.method === "DELETE") return Response.json({ logo: null });
        }
        unexpected.push(`${request.method} ${path}`);
        throw new Error(`Unexpected request: ${request.method} ${path}`);
      },
      { preconnect: originalFetch.preconnect },
    );
    globalThis.fetch = fetch;
    Object.defineProperty(dom.window, "fetch", { configurable: true, writable: true, value: fetch });
  });

  afterEach(async () => {
    try {
      dialogCore.close();
      await Bun.sleep(20);
      dispose();
      expect(unexpected).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

  let dirtyReports: boolean[] = [];
  const mount = (locale: "en" | "de" = "en", canManage = true) => {
    dirtyReports = [];
    // Prompts have their own Solid root and inherit the document's locale.
    dom.document.documentElement.lang = locale;
    dispose = render(
      () => (
        <LocaleProvider locale={locale}>
          <MailboxLogoSettings mailboxId="Box001" canManage={canManage} onDirtyChange={(dirty) => dirtyReports.push(dirty)} />
        </LocaleProvider>
      ),
      dom.root,
    );
  };
  const group = () => dom.root.querySelector<HTMLElement>("section.k2b-settings-group")!;
  const text = () => group().textContent ?? "";
  const image = () => group().querySelector<HTMLImageElement>("img");
  const dropzone = () => group().querySelector<HTMLButtonElement>('button[id^="mail-logo-file-"]')!;
  const widthInput = () => group().querySelector<HTMLInputElement>('input[role="spinbutton"]')!;
  const altInput = () => group().querySelector<HTMLInputElement>('input[id^="mail-logo-alt-"]')!;
  const button = (label: string, within: ParentNode = group()) => {
    const result = Array.from(within.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === label);
    expect(result).toBeDefined();
    return result!;
  };
  const writes = () => requests.filter((request) => request.method !== "GET");
  const chooseFile = (base64 = content) => {
    const input = group().querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File([Buffer.from(base64, "base64")], "logo.png", { type: "image/png", lastModified: 0 });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const edit = (input: HTMLInputElement, value: string) => {
    input.focus();
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.blur();
  };
  const expectImage = (logo: Logo) => {
    expect(image()).not.toBeNull();
    expect(image()!.getAttribute("src")).toBe(logo.dataUrl);
    expect(image()!.getAttribute("alt")).toBe(logo.altText);
    expect(image()!.getAttribute("width")).toBe(String(logo.displayWidth));
    expect(image()!.getAttribute("height")).toBe(String(Math.round((logo.displayWidth * logo.pixelHeight) / logo.pixelWidth)));
  };
  const expectUploadError = (message: string) => {
    const control = dropzone();
    expect(control.getAttribute("aria-invalid")).toBe("true");
    const describedBy = control.getAttribute("aria-describedby")?.split(/\s+/) ?? [];
    const error = describedBy.map((id) => dom.document.getElementById(id)).find((element) => element?.getAttribute("role") === "alert");
    expect(error?.textContent).toBe(message);
    expect(control.closest(".k2b-field")?.contains(error!)).toBe(true);
    expect(group().contains(error!)).toBe(true);
  };

  test("uploads a first logo with bytes only, shows the returned image and restores dropzone focus", async () => {
    mount();
    await waitFor(() => text().includes("No logo yet"));
    expect(dropzone().textContent).toContain("Upload a logo");
    expect(dropzone().disabled).toBe(false);
    chooseFile();
    await waitFor(() => image() !== null && dom.document.activeElement === dropzone());
    expect(writes()).toEqual([{ method: "PUT", path: endpoint, body: { content } }]);
    expectImage(storedLogo);
    expect(text()).not.toContain("No logo yet");
    expect(dropzone().querySelector("strong")?.textContent).toBe("Replace the logo");
    expect(dom.document.activeElement?.id).toBe(dropzone().id);
  });

  test("reports no upload when the settings close while the upload is still running", async () => {
    let started = false;
    putResponse = (request) => {
      started = true;
      return new Promise<Response>((_resolve, reject) =>
        request.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))),
      );
    };
    const success = spyOn(toast, "success");
    try {
      mount();
      await waitFor(() => text().includes("No logo yet"));
      chooseFile();
      await waitFor(() => started);
      dispose();
      dispose = () => {};
      await Bun.sleep(20);
      expect(success).not.toHaveBeenCalled();
    } finally {
      success.mockRestore();
    }
  });

  test("starts no upload when the settings close while the file is still being read", async () => {
    let finishRead = () => {};
    const bytes = Buffer.from(content, "base64");
    const slowFile = {
      name: "logo.png",
      type: "image/png",
      size: bytes.byteLength,
      arrayBuffer: () =>
        new Promise<ArrayBuffer>((resolve) => {
          finishRead = () => resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        }),
    };
    mount();
    await waitFor(() => text().includes("No logo yet"));
    const input = group().querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [slowFile] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => dropzone().disabled);
    // Nothing else may start while the file is read.
    expect(widthInput().disabled).toBe(true);
    expect(button("Remove").disabled).toBe(true);
    dispose();
    dispose = () => {};
    finishRead();
    await Bun.sleep(20);
    expect(writes()).toEqual([]);
  });

  test("reports unsaved width and alt text to the settings until they are saved", async () => {
    initialLogo = storedLogo;
    putResponse = () => Response.json({ logo: { ...storedLogo, altText: "Team logo" } });
    mount();
    await waitFor(() => image() !== null);
    expect(dirtyReports.at(-1)).toBe(false);
    edit(altInput(), "Team logo");
    expect(dirtyReports.at(-1)).toBe(true);
    button("Save").click();
    await waitFor(() => button("Save").disabled && image()?.getAttribute("alt") === "Team logo");
    expect(dirtyReports.at(-1)).toBe(false);
    edit(widthInput(), "300");
    expect(dirtyReports.at(-1)).toBe(true);
    dispose();
    dispose = () => {};
    expect(dirtyReports.at(-1)).toBe(false);
  });

  test("shows the German server validation message in the dropzone field and keeps the empty state", async () => {
    const message = "Das Logo hat 2000×500 Pixel; erlaubt sind höchstens 1200×400 Pixel.";
    putResponse = () => Response.json({ code: "BAD_INPUT", message }, { status: 400 });
    mount("de");
    await waitFor(() => text().includes("Noch kein Logo"));
    chooseFile();
    await waitFor(() => text().includes(message));
    expectUploadError(message);
    expect(writes()).toEqual([{ method: "PUT", path: endpoint, body: { content } }]);
    expect(dom.document.body.textContent).not.toContain("BAD_INPUT");
    expect(text()).toContain("Noch kein Logo");
    expect(image()).toBeNull();
  });

  test("rejects files above 100 KiB locally with a German field error and sends no PUT", async () => {
    mount("de");
    await waitFor(() => text().includes("Noch kein Logo"));
    chooseFile(Buffer.alloc(102_401).toString("base64"));
    const message = "Das Logo darf höchstens 100 KiB groß sein. Wähle eine kleinere Datei.";
    await waitFor(() => text().includes(message));
    expectUploadError(message);
    await Bun.sleep(20);
    expect(writes()).toEqual([]);
    expect(text()).toContain("Noch kein Logo");
    expect(image()).toBeNull();
  });

  test("reuses the stored bytes when saving width and alt text, then disables Save again", async () => {
    initialLogo = storedLogo;
    const updated = { ...storedLogo, displayWidth: 300, altText: "Team logo" };
    putResponse = () => Response.json({ logo: updated });
    mount();
    await waitFor(() => image() !== null);
    expectImage(storedLogo);
    expect(button("Save").disabled).toBe(true);
    edit(widthInput(), "300");
    edit(altInput(), "Team logo");
    expect(button("Save").disabled).toBe(false);
    button("Save").click();
    await waitFor(() => image()?.getAttribute("alt") === "Team logo" && button("Save").disabled);
    expect(writes()).toEqual([{ method: "PUT", path: endpoint, body: { content, displayWidth: 300, altText: "Team logo" } }]);
    expectImage(updated);
    expect(widthInput().value).toBe("300");
    expect(altInput().value).toBe("Team logo");
    expect(button("Save").disabled).toBe(true);
  });

  test("replaces a stored logo with new bytes while preserving its stored width and alt text", async () => {
    initialLogo = storedLogo;
    const replacement = {
      ...storedLogo,
      pixelWidth: 4,
      pixelHeight: 1,
      byteLength: 72,
      sha256: "b92368fcf7ef5a164d35524affe47e15e8e1bb6f34efd81e37388b082af2802d",
      dataUrl: `data:image/png;base64,${replacementContent}`,
    };
    putResponse = () => Response.json({ logo: replacement });
    mount();
    await waitFor(() => image() !== null);
    // Unsaved edits must not replace the details of the stored logo during file replacement.
    edit(widthInput(), "300");
    edit(altInput(), "Unsaved alt text");
    chooseFile(replacementContent);
    await waitFor(() => image()?.getAttribute("src") === replacement.dataUrl && dom.document.activeElement === dropzone());
    expect(writes()).toEqual([
      {
        method: "PUT",
        path: endpoint,
        body: { content: replacementContent, displayWidth: storedLogo.displayWidth, altText: storedLogo.altText },
      },
    ]);
    expectImage(replacement);
    expect(widthInput().value).toBe("200");
    expect(altInput().value).toBe(storedLogo.altText);
    expect(button("Save").disabled).toBe(true);
  });

  test("requires removal confirmation, keeps the logo on cancel and empties it on confirmation", async () => {
    initialLogo = storedLogo;
    mount();
    await waitFor(() => image() !== null);
    button("Remove").click();
    await waitFor(() => Boolean(dom.document.querySelector("dialog h2")));
    let dialog = dom.document.querySelector("dialog")!;
    expect(dialog.querySelector("h2")?.textContent).toBe("Remove the logo?");
    expect(writes()).toEqual([]);
    button("Cancel", dialog).click();
    await waitFor(() => !dialogCore.isOpen());
    expect(writes()).toEqual([]);
    expectImage(storedLogo);

    button("Remove").click();
    await waitFor(() => dialogCore.isOpen());
    dialog = dom.document.querySelector("dialog")!;
    expect(dialog.querySelector("h2")?.textContent).toBe("Remove the logo?");
    button("Remove", dialog).click();
    await waitFor(() => text().includes("No logo yet") && dom.document.activeElement === dropzone());
    expect(writes()).toEqual([{ method: "DELETE", path: endpoint, body: null }]);
    expect(image()).toBeNull();
    expect(widthInput().disabled).toBe(true);
    expect(altInput().disabled).toBe(true);
    expect(button("Remove").disabled).toBe(true);
    expect(button("Save").disabled).toBe(true);
    expect(dropzone().disabled).toBe(false);
    expect(dom.document.activeElement?.id).toBe(dropzone().id);
  });

  test("disables upload after a failed load and retries GET to show the logo", async () => {
    let loads = 0;
    getResponse = () => (++loads === 1 ? Response.json({ message: "boom" }, { status: 500 }) : Response.json({ logo: storedLogo }));
    mount();
    await waitFor(() => text().includes("The logo could not be loaded"));
    expect(text()).toContain("boom");
    expect(dropzone().disabled).toBe(true);
    expect(group().querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(true);
    expect(image()).toBeNull();
    button("Retry").click();
    await waitFor(() => image() !== null);
    expect(requests).toEqual([
      { method: "GET", path: endpoint, body: null },
      { method: "GET", path: endpoint, body: null },
    ]);
    expectImage(storedLogo);
    expect(text()).not.toContain("The logo could not be loaded");
    expect(dropzone().disabled).toBe(false);
  });

  test("keeps the stored logo and all disabled controls visible for a non-admin without sending writes", async () => {
    initialLogo = storedLogo;
    mount("en", false);
    await waitFor(() => image() !== null);
    expectImage(storedLogo);
    expect(widthInput().value).toBe("200");
    expect(altInput().value).toBe("Company logo");
    expect(text()).toContain("Only mailbox admins can change the logo.");
    expect(dropzone().disabled).toBe(true);
    expect(group().querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(true);
    expect(widthInput().disabled).toBe(true);
    expect(altInput().disabled).toBe(true);
    expect(button("Remove").disabled).toBe(true);
    expect(button("Save").disabled).toBe(true);
    dropzone().click();
    button("Save").click();
    button("Remove").click();
    chooseFile(replacementContent);
    await Bun.sleep(30);
    expect(writes()).toEqual([]);
    expect(dialogCore.isOpen()).toBe(false);
    expectImage(storedLogo);
  });
});
