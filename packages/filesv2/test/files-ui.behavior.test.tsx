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
  ],
  next: "next/+=",
};

// These tests exercise real components with controlled API responses, not a live browser.
describe("Files v2 interactions", () => {
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
      json: { url: "http://filegate:4001", cloud: configuration.cloud, freeipa: configuration.freeipa },
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
      json: { url: "http://filegate:4001", cloud: configuration.cloud, freeipa: configuration.freeipa, token: "replacement-test-token" },
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
    const rows = [...dom.root.querySelectorAll<HTMLElement>(".filesv2-list__row")];
    rows[0]!.click();
    expect(opened).toBe("Budget #1/Final ?");
    const next = [...dom.root.querySelectorAll<HTMLAnchorElement>("a")].find((entry) => entry.textContent?.includes("Next page"))!;
    expect(new URL(next.href, "https://cloud.test").searchParams.get("after")).toBe("next/+=");
    rows[1]!.click();
    await flush();
    const download = [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Download")!;
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
});
