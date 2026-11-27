import { afterEach, describe, expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type { DirectoryResult, PublicConfiguration } from "../src/contracts";

const requests: Array<{ kind: string; input: unknown; signal: AbortSignal; resolve: (response: Response) => void }> = [];
let refreshes = 0;
if (!isServer) {
  const request = (kind: string) => (input: unknown, options: { init: { signal: AbortSignal } }) =>
    new Promise<Response>((resolve) => requests.push({ kind, input: structuredClone(input), signal: options.init.signal, resolve }));
  mock.module("../src/api/client", () => ({
    apiClient: {
      bases: {
        ":baseId": {
          download: { $post: request("download") },
          entry: {
            $get: async (input: { query: { path: string } }) =>
              Response.json({ base: directory.base, entry: [...directory.items, notPdf].find((item) => item.path === input.query.path) }),
          },
        },
      },
      admin: { configuration: { $put: request("configuration") }, adopt: { $post: request("adopt") } },
    },
  }));
  const navigation = await import("@k2b/ssr/nav");
  mock.module("@k2b/ssr/nav", () => ({
    ...navigation,
    refreshCurrentPath: async () => {
      refreshes++;
    },
  }));
}
const flush = async () => {
  for (let index = 0; index < 16; index++) await Promise.resolve();
};
const configuration: PublicConfiguration = {
  activityRetentionDays: 365,
  url: "http://filegate:4000",
  tokenConfigured: true,
  cloud: {
    autoCreate: false,
    autoArchive: true,
    enabled: false,
    root: "cloud",
    prefix: "",
    homes: "users",
    groups: "groups",
    archive: "archive",
  },
  freeipa: { enabled: true, root: "freeipa", prefix: "", homes: "users", groups: "groups", archive: "archive" },
  collabora: { url: "", internalUrl: "", wopiOrigin: "", documentFormat: "odf" },
};
const directory: DirectoryResult = {
  base: {
    id: "base-1",
    area: "freeipa",
    kind: "groups",
    name: "Finance",
    status: "existing",
    reason: null,
    indexEnabled: false,
    versioningEnabled: false,
  },
  path: "Budget #1",
  items: [
    { name: "Final ?", path: "Budget #1/Final ?", directory: true, size: 0, modified: "2026-09-17T10:00:00Z" },
    { name: "report.txt", path: "Budget #1/report.txt", directory: false, size: 4, modified: "2026-09-17T10:00:00Z" },
    { name: "Bericht Q3.pdf", path: "Budget #1/Bericht Q3.pdf", directory: false, size: 8, modified: "2026-09-17T10:00:00Z" },
  ],
  next: "next/+=",
};

const notPdf = {
  name: "Kein PDF (Demo).pdf",
  path: "Budget #1/Kein PDF (Demo).pdf",
  directory: false,
  size: 17,
  modified: "2026-09-17T10:00:00Z",
};

// These tests exercise real components with controlled API responses, not a live browser.
describe("Filesv2 interactions", () => {
  if (isServer) {
    test.skip("requires the package DOM runner", () => {});
    return;
  }
  let cleanup = () => {};
  afterEach(() => {
    cleanup();
    requests.length = 0;
    refreshes = 0;
  });

  test("configuration never preloads a token and keeps user input after an API failure", async () => {
    const dom = createDomTestHarness();
    const { default: Settings } = await import("../src/frontend/Settings");
    const dispose = render(
      () =>
        createComponent(Settings, {
          configuration,
          availability: { localLinuxEnabled: false, freeipaEnabled: true },
          onSaved: async () => {
            refreshes++;
          },
          onDirtyChange: () => {},
        }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    const secret = dom.document.querySelector<HTMLInputElement>('input[name="filegate-token"]')!;
    expect(secret.value).toBe("");
    expect(dom.root.textContent).toContain("Leave this blank to keep it");
    expect(dom.root.textContent).toContain("Personal storage and local POSIX group folders require local Linux identities");
    expect(dom.root.textContent).toContain("Independent machine storage uses explicit path grants and needs no Unix identity provisioning");
    const form = dom.root.querySelector("form")!;
    const submit = () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    const url = dom.root.querySelector<HTMLInputElement>('input[name="filegate-url"]')!;
    url.value = "http://filegate:4001";
    url.dispatchEvent(new Event("input", { bubbles: true }));
    submit();
    submit();
    await flush();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.input).toEqual({
      json: {
        activityRetentionDays: 365,
        url: "http://filegate:4001",
        cloud: configuration.cloud,
        freeipa: configuration.freeipa,
        collabora: configuration.collabora,
      },
    });
    requests[0]!.resolve(Response.json({ code: "unavailable", message: "Filegate is unavailable." }, { status: 503 }));
    await flush();
    expect(dom.root.querySelector('[role="alert"]')?.textContent).toContain("Filegate is unavailable");
    expect(dom.document.querySelector<HTMLInputElement>('input[name="filegate-url"]')!.value).toBe("http://filegate:4001");
    secret.value = "replacement-test-token";
    secret.dispatchEvent(new Event("input", { bubbles: true }));
    submit();
    await flush();
    expect(requests).toHaveLength(2);
    expect(requests[1]!.input).toEqual({
      json: {
        activityRetentionDays: 365,
        url: "http://filegate:4001",
        cloud: configuration.cloud,
        freeipa: configuration.freeipa,
        collabora: configuration.collabora,
        token: "replacement-test-token",
      },
    });
    requests[1]!.resolve(Response.json({}));
    await flush();
    expect(secret.value).toBe("");
    expect(refreshes).toBe(1);
  });

  test("a .pdf whose content is not a PDF offers only its download, not the viewer tab", async () => {
    const dom = createDomTestHarness();
    const { default: FilePreview } = await import("../src/frontend/FilePreview");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async () => new Response("<html>Demo</html>", { headers: { "content-type": "text/html" } }), {
      preconnect: originalFetch.preconnect,
    });
    const downloads: string[] = [];
    const dispose = render(
      () =>
        createComponent(FilePreview, {
          baseId: "base-1",
          entry: { name: "Kein PDF (Demo).pdf", path: "Kein PDF (Demo).pdf", directory: false, size: 17, modified: "2026-09-17T10:00:00Z" },
          onDownload: () => downloads.push("download"),
        }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    };
    for (let round = 0; round < 8; round++) {
      for (const request of requests)
        if (request.kind === "download" && !request.signal.aborted)
          request.resolve(Response.json({ url: "https://filegate.test/lease/demo", method: "GET", expires: "2026-09-17T10:01:00Z" }));
      await flush();
      await Bun.sleep(0);
    }

    expect(dom.root.querySelector("iframe")).toBeNull();
    expect(dom.root.querySelector("a")).toBeNull();
    expect(dom.root.textContent).toContain("This file is not a PDF");
    const actions = [...dom.root.querySelectorAll<HTMLButtonElement>("button")];
    expect(actions.map((action) => action.textContent?.trim())).toEqual(["Download"]);
    actions[0]!.click();
    expect(downloads).toEqual(["download"]);
  });

  test("PDF preview actions follow the German locale", async () => {
    const dom = createDomTestHarness();
    dom.document.documentElement.lang = "de";
    const { default: FilePreview } = await import("../src/frontend/FilePreview");
    const { Lightbox, LocaleProvider } = await import("@k2b/ui");
    const { fileLightboxItem } = await import("../src/frontend/file-lightbox");
    const { browserMessages } = await import("../src/frontend/browser-messages");
    const entry = { name: "Bericht.pdf", path: "Bericht.pdf", directory: false, size: 8, modified: "2026-09-17T10:00:00Z" };
    // On its own, the preview of a PDF is only the document.
    const dispose = render(() => createComponent(FilePreview, { baseId: "base-1", entry, onDownload: () => {} }), dom.root);
    expect(dom.root.querySelectorAll("a, button")).toHaveLength(0);
    // Large, the Lightbox names Files' commands and its own in German.
    const b = browserMessages.resolve(["de"]).t;
    const item = fileLightboxItem(
      "base-1",
      entry,
      { onDownload: () => {} },
      {
        open: b.open,
        openReadOnly: b.openReadOnly,
        openInTab: b.openInTab,
        copyText: b.copyText,
        copied: b.copiedText,
        share: b.shareSelection,
        failed: b.previewFailed,
      },
      "de",
    );
    const host = dom.document.createElement("div");
    dom.document.body.append(host);
    const disposeLightbox = render(
      () =>
        createComponent(LocaleProvider, {
          locale: "de",
          get children() {
            return createComponent(Lightbox, { items: [item], index: 0, onIndexChange: () => {}, onClose: () => {} });
          },
        }),
      host,
    );
    await flush();
    cleanup = () => {
      disposeLightbox();
      dispose();
      dom.cleanup();
    };
    const actions = dom.document.querySelectorAll("dialog.k2b-lightbox .k2b-lightbox__actions :is(a, button)");
    const labels = [...actions].map((action) => action.getAttribute("aria-label"));
    expect(labels).toEqual(["In neuem Tab öffnen", "Herunterladen", "Schließen"]);
  });
});
