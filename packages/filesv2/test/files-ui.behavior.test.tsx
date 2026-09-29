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
              Response.json({ base: directory.base, entry: directory.items.find((item) => item.path === input.query.path) }),
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
    expect(dom.root.textContent).toContain("Cloud files require local Linux identities");
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
      json: { url: "http://filegate:4001", cloud: configuration.cloud, freeipa: configuration.freeipa, collabora: configuration.collabora },
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

  test("downloads ask Cloud for an exact path once and preserve the directory on failure", async () => {
    const dom = createDomTestHarness();
    const { default: Browser } = await import("../src/frontend/Browser");
    let opened = "";
    const dispose = render(
      () =>
        createComponent(Browser, {
          directory,
          bases: [directory.base],
          cloudUrl: "https://cloud.test",
          onNavigate: async () => {},
          onOpenDirectory: (path) => (opened = path),
        }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    const rows = [...dom.root.querySelectorAll<HTMLElement>(".filesv2-list__row:not(.filesv2-list__row--up)")];
    rows[0]!.click();
    expect(opened).toBe("Budget #1/Final ?");
    const next = [...dom.root.querySelectorAll<HTMLAnchorElement>("a")].find((entry) => entry.textContent?.includes("Next page"))!;
    expect(new URL(next.href, "https://cloud.test").searchParams.get("after")).toBe("next/+=");
    rows[1]!.click();
    await flush();
    const download = [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Download",
    )!;
    // The inspector preview already asked for a lease; only the explicit download is counted here.
    const before = requests.length;
    download.click();
    download.click();
    await flush();
    expect(requests).toHaveLength(before + 1);
    expect(requests[before]!.input).toEqual({ param: { baseId: "base-1" }, json: { path: "Budget #1/report.txt" } });
    requests[before]!.resolve(Response.json({ code: "forbidden", message: "Access changed." }, { status: 403 }));
    await flush();
    expect(dom.document.body.textContent).toContain("Access changed");
    expect(dom.root.textContent).toContain("report.txt");
    expect(download.disabled).toBe(false);
    download.click();
    await flush();
    expect(requests).toHaveLength(before + 2);
    dispose();
    expect(requests[before + 1]!.signal.aborted).toBe(true);
    cleanup = () => dom.cleanup();
  });

  test("a previewed PDF opens in a new tab at its stable address and downloads through a fresh lease", async () => {
    const dom = createDomTestHarness();
    const { default: Browser } = await import("../src/frontend/Browser");
    const pdf = directory.items[2]!;
    const bytes = "%PDF-1.4";
    const originalFetch = globalThis.fetch;
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const fetched: string[] = [];
    const objectUrls = new Map<string, Blob>();
    const clicked: Array<{ href: string; download: string }> = [];
    const tab = {
      opener: {} as unknown,
      closed: false,
      document: { title: "", body: { textContent: "" } },
      location: { href: "" },
      close() {},
    };
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        fetched.push(String(input));
        return new Response(bytes, { headers: { "content-type": "application/pdf" } });
      },
      { preconnect: originalFetch.preconnect },
    );
    URL.createObjectURL = (blob) => {
      const url = `blob:preview-${objectUrls.size + 1}`;
      objectUrls.set(url, blob as Blob);
      return url;
    };
    URL.revokeObjectURL = () => {};
    const anchor = dom.window.HTMLAnchorElement.prototype;
    const originalClick = anchor.click;
    dom.window.open = (() => tab) as unknown as typeof dom.window.open;
    anchor.click = function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download });
    };
    const dispose = render(
      () =>
        createComponent(Browser, {
          directory,
          bases: [directory.base],
          cloudUrl: "https://cloud.test",
          onNavigate: async () => {},
        }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      globalThis.fetch = originalFetch;
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      anchor.click = originalClick;
      dom.cleanup();
    };
    // Every lease Cloud issues here is distinct, so a URL identifies the request that produced it.
    const settleLeases = async () => {
      for (let round = 0; round < 8; round++) {
        for (const [index, request] of requests.entries())
          if (request.kind === "download" && !request.signal.aborted)
            request.resolve(Response.json({ url: `https://filegate.test/lease/${index}`, method: "GET", expires: "2026-09-17T10:01:00Z" }));
        await flush();
        await Bun.sleep(0);
      }
    };

    [...dom.root.querySelectorAll<HTMLElement>(".filesv2-list__row")].find((row) => row.textContent?.includes(pdf.name))!.click();
    await settleLeases();
    [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Preview")!.click();
    await settleLeases();

    const dialog = dom.document.querySelector("dialog")!;
    expect(dialog.querySelector("iframe")?.getAttribute("src")).toMatch(/^blob:preview-/);
    const [open, download] = [...dialog.querySelectorAll<HTMLElement>(".filesv2-preview :is(a, button)")];
    // Visible text names each action for keyboard and screen-reader users; reloading an unchanged file is not offered.
    expect([open, download].map((action) => action?.textContent?.trim())).toEqual(["Open in new tab", "Download"]);
    expect([open, download].every((action) => !action!.hasAttribute("disabled") && !action!.hasAttribute("aria-label"))).toBe(true);
    // The tab reads the stored file from Cloud, so it reloads and the viewer names it after the file.
    expect(open).toBeInstanceOf(dom.window.HTMLAnchorElement);
    expect(open!.getAttribute("href")).toBe("/api/filesv2/bases/base-1/pdf/Budget%20%231/Bericht%20Q3.pdf");
    expect(open!.getAttribute("target")).toBe("_blank");
    expect(open!.getAttribute("rel")).toBe("noopener");
    const leasesBefore = requests.length;
    const fetchesBefore = fetched.length;

    download!.click();
    await flush();
    expect(requests).toHaveLength(leasesBefore + 1);
    expect(requests[leasesBefore]!.input).toEqual({ param: { baseId: "base-1" }, json: { path: pdf.path } });
    await settleLeases();
    expect(clicked).toEqual([{ href: `https://filegate.test/lease/${leasesBefore}`, download: pdf.name }]);
    expect(fetched).toHaveLength(fetchesBefore);
  });

  test("PDF preview actions follow the German locale", async () => {
    const dom = createDomTestHarness();
    dom.document.documentElement.lang = "de";
    const { default: FilePreview } = await import("../src/frontend/FilePreview");
    const dispose = render(
      () =>
        createComponent(FilePreview, {
          baseId: "base-1",
          entry: { name: "Bericht.pdf", path: "Bericht.pdf", directory: false, size: 8, modified: "2026-09-17T10:00:00Z" },
          onDownload: () => {},
        }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    const labels = [...dom.root.querySelectorAll("a, button")].map((action) => action.textContent?.trim());
    expect(labels).toEqual(["In neuem Tab öffnen", "Herunterladen"]);
  });
});
