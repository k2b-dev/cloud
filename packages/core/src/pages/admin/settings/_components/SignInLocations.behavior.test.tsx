import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { GeoIpAdminStatus } from "@k2b/cloud/contracts";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import { bundledStatus, uploadedStatus } from "./sign-in-locations-fixture";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A scripted XMLHttpRequest: the test decides when progress, the end of the upload and the answer arrive. */
class FakeXhr {
  static last: FakeXhr | undefined;
  static sent: unknown[] = [];
  method = "";
  url = "";
  status = 0;
  responseText = "";
  aborted = false;
  headers: Record<string, string> = {};
  upload: { onprogress?: (event: { lengthComputable: boolean; loaded: number; total: number }) => void; onload?: () => void } = {};
  onload?: () => void;
  onerror?: () => void;
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    FakeXhr.last = this;
    FakeXhr.sent.push(body);
  }
  abort() {
    this.aborted = true;
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }
  respond(status: number, body: unknown) {
    this.upload.onload?.();
    this.status = status;
    this.responseText = typeof body === "string" ? body : JSON.stringify(body);
    this.onload?.();
  }
}

let cleanup = () => {};
afterEach(() => {
  cleanup();
  mock.restore();
  FakeXhr.last = undefined;
  FakeXhr.sent = [];
});

const mount = async (options: { initial?: GeoIpAdminStatus | null; locale?: string } = {}) => {
  if (isServer) throw new Error("Run behavior tests with the browser export condition.");
  const dom = createDomTestHarness();
  const previousXhr = Object.getOwnPropertyDescriptor(globalThis, "XMLHttpRequest");
  Object.defineProperty(globalThis, "XMLHttpRequest", { configurable: true, writable: true, value: FakeXhr });
  const ui = await import("@k2b/ui");
  const confirm = spyOn(ui.prompts, "confirm").mockResolvedValue(true);
  spyOn(ui, "announce").mockImplementation(() => {});
  const requests: { url: string; method: string }[] = [];
  let answer: (url: string, method: string) => Response = () => Response.json(bundledStatus);
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (url: unknown, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        requests.push({ url: String(url), method });
        return answer(String(url), method);
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  const { default: SignInLocations } = await import("./SignInLocations");
  const { LocaleProvider } = ui;
  const dispose = render(
    () =>
      createComponent(LocaleProvider, {
        locale: options.locale ?? "en",
        get children() {
          return createComponent(SignInLocations, { initial: options.initial === undefined ? bundledStatus : options.initial });
        },
      }),
    dom.root,
  );
  cleanup = () => {
    dispose();
    dom.cleanup();
    if (previousXhr) Object.defineProperty(globalThis, "XMLHttpRequest", previousXhr);
    else delete (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  };
  const root = dom.root;
  const statusLine = () =>
    [...(root.querySelector("[data-geoip-status]")?.children ?? [])].map((node) => node.textContent?.replace(/\s+/g, " ").trim()).join(" ");
  const source = (kind: "city" | "asn") => root.querySelector(`[data-geoip-kind="${kind}"] [data-geoip-source]`)?.textContent ?? "";
  const detail = (kind: "city" | "asn") => root.querySelector(`[data-geoip-kind="${kind}"] [data-geoip-date]`)?.textContent ?? "";
  const button = (label: string) => [...root.querySelectorAll("button")].find((node) => node.textContent?.trim().endsWith(label));
  const uploadButton = () => root.querySelector<HTMLButtonElement>("[data-geoip-upload]")!;
  const resetButton = (kind: "city" | "asn") => root.querySelector<HTMLButtonElement>(`[data-geoip-kind="${kind}"] button`)!;
  const choose = async (name = "dbip-city-lite-2026-11.mmdb.gz") => {
    const input = root.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new dom.window.File([new Uint8Array([1, 2, 3])], name);
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    return file;
  };
  return {
    dom,
    root,
    confirm,
    requests,
    respondWith: (next: typeof answer) => {
      answer = next;
    },
    statusLine,
    source,
    detail,
    button,
    uploadButton,
    resetButton,
    choose,
  };
};

describe("sign-in locations block", () => {
  test("an upload shows progress, then the check, then the new source in its row", async () => {
    const view = await mount();
    expect(view.source("city")).toBe("Bundled DB-IP Lite snapshot");
    expect(view.resetButton("city").disabled).toBe(true);
    const file = await view.choose();
    const xhr = FakeXhr.last!;
    expect([xhr.method, xhr.url, xhr.headers["content-type"]]).toEqual(["PUT", "/api/admin/core/geoip", "application/octet-stream"]);
    expect(FakeXhr.sent).toEqual([file]);
    expect(view.uploadButton().disabled).toBe(true);
    xhr.progress(32, 100);
    await flush();
    expect(view.statusLine()).toBe("Uploading · 32 % Cancel");
    xhr.progress(100, 100);
    await flush();
    expect(view.statusLine()).toBe("Checking the file");
    xhr.respond(200, { ...uploadedStatus, kind: "city" });
    await flush();
    expect(view.statusLine()).toBe("Uploaded. Sign-in requests now use this file for places.");
    expect(view.source("city")).toBe("Uploaded file");
    expect(view.detail("city")).toBe("As of Oct 14, 2026 · GeoLite2-City");
    expect(view.resetButton("city").disabled).toBe(false);
    expect(view.uploadButton().disabled).toBe(false);
  });

  test("a rejected file keeps the old database and offers another file, not the same one again", async () => {
    const view = await mount();
    await view.choose("notes.txt");
    FakeXhr.last!.respond(422, { code: "geoip_invalid" });
    await flush();
    expect(view.statusLine()).toBe("This is not a readable MMDB database. Nothing was changed.");
    expect(view.source("city")).toBe("Bundled DB-IP Lite snapshot");
    expect(FakeXhr.sent).toHaveLength(1);
  });

  test("a platform 413 without Cloud's code asks for the gzip file", async () => {
    const view = await mount();
    await view.choose("dbip-city-lite.mmdb");
    FakeXhr.last!.respond(413, "Payload Too Large");
    await flush();
    expect(view.statusLine()).toBe("The file is too large to send. Upload it as .mmdb.gz.");
  });

  test("an interrupted upload whose result Cloud does not show yet stays unclear instead of claiming nothing changed", async () => {
    const view = await mount();
    await view.choose();
    FakeXhr.last!.onerror?.();
    await flush();
    await flush();
    expect(view.requests).toEqual([{ url: "/api/admin/core/geoip", method: "GET" }]);
    expect(view.statusLine()).toBe("Unclear whether the change was saved. Load status");
    expect(view.uploadButton().disabled).toBe(false);
  });

  test("a busy server gets the same file again with one click", async () => {
    const view = await mount();
    const file = await view.choose();
    FakeXhr.last!.respond(409, { code: "geoip_upload_busy" });
    await flush();
    expect(view.statusLine()).toBe("Another upload is still running. Try again");
    view.button("Try again")!.click();
    await flush();
    expect(FakeXhr.sent).toEqual([file, file]);
    expect(view.statusLine()).toStartWith("Uploading · 0 %");
  });

  test("a lost answer after a committed upload reports the upload, not a failure", async () => {
    const view = await mount();
    view.respondWith(() => Response.json(uploadedStatus));
    await view.choose();
    FakeXhr.last!.respond(502, "Bad Gateway");
    await flush();
    await flush();
    expect(view.statusLine()).toBe("Uploaded. Sign-in requests now use this file for places.");
    expect(view.source("city")).toBe("Uploaded file");
  });

  test("when Cloud cannot say what is active, the block says so and offers to load the status", async () => {
    const view = await mount();
    view.respondWith(() => {
      throw new TypeError("offline");
    });
    await view.choose();
    FakeXhr.last!.onerror?.();
    await flush();
    await flush();
    expect(view.statusLine()).toBe("Unclear whether the change was saved. Load status");
    expect(view.uploadButton().disabled).toBe(false);
    view.respondWith(() => Response.json(bundledStatus));
    view.button("Load status")!.click();
    await flush();
    await flush();
    expect(view.statusLine()).toBe("City or ASN database in MMDB format, also as .mmdb.gz, up to 192 MiB unpacked.");
  });

  test("cancel aborts the upload and returns to the starting hint", async () => {
    const view = await mount();
    await view.choose();
    const xhr = FakeXhr.last!;
    view.button("Cancel")!.click();
    await flush();
    expect(xhr.aborted).toBe(true);
    expect(view.statusLine()).toBe("City or ASN database in MMDB format, also as .mmdb.gz, up to 192 MiB unpacked.");
    // A late answer of the cancelled request changes nothing.
    xhr.respond(200, { ...uploadedStatus, kind: "city" });
    await flush();
    expect(view.source("city")).toBe("Bundled DB-IP Lite snapshot");
  });

  test("offline disables upload and reset and says why in the status line", async () => {
    const view = await mount({ initial: uploadedStatus });
    expect(view.resetButton("city").disabled).toBe(false);
    Object.defineProperty(view.dom.window.navigator, "onLine", { configurable: true, get: () => false });
    view.dom.window.dispatchEvent(new view.dom.window.Event("offline"));
    await flush();
    expect(view.statusLine()).toBe("You are offline. Uploading and resetting work again once you are connected.");
    expect(view.uploadButton().disabled).toBe(true);
    expect(view.resetButton("city").disabled).toBe(true);
    Object.defineProperty(view.dom.window.navigator, "onLine", { configurable: true, get: () => true });
    view.dom.window.dispatchEvent(new view.dom.window.Event("online"));
    await flush();
    expect(view.uploadButton().disabled).toBe(false);
  });

  test("a status the server could not read shows an error with a retry that loads it", async () => {
    const view = await mount({ initial: null });
    expect(view.statusLine()).toBe("Could not load the status. Try again");
    expect(view.uploadButton().disabled).toBe(true);
    view.button("Try again")!.click();
    await flush();
    await flush();
    expect(view.requests).toEqual([{ url: "/api/admin/core/geoip", method: "GET" }]);
    expect(view.source("asn")).toBe("Bundled DB-IP Lite snapshot");
    expect(view.uploadButton().disabled).toBe(false);
  });

  test("reset asks first, deletes that type and names the bundled snapshot again", async () => {
    const view = await mount({ initial: uploadedStatus });
    view.respondWith(() => Response.json({ ...bundledStatus, changed: true }));
    view.resetButton("city").click();
    await flush();
    await flush();
    expect(view.confirm).toHaveBeenCalledTimes(1);
    expect(view.requests).toEqual([{ url: "/api/admin/core/geoip/city", method: "DELETE" }]);
    expect(view.statusLine()).toBe("Reset. Places use the bundled snapshot again.");
    expect(view.source("city")).toBe("Bundled DB-IP Lite snapshot");
  });

  test("a refused reset keeps the uploaded file and offers a retry", async () => {
    const view = await mount({ initial: uploadedStatus, locale: "de" });
    view.respondWith(() => Response.json({ code: "FORBIDDEN" }, { status: 403 }));
    view.resetButton("city").click();
    await flush();
    await flush();
    expect(view.requests.map((request) => request.method)).toEqual(["DELETE"]);
    expect(view.statusLine()).toBe("Zurücksetzen hat nicht geklappt. Nichts wurde geändert. Erneut versuchen");
    expect(view.source("city")).toBe("Hochgeladene Datei");
  });

  test("a server error on reset with the upload still listed stays unclear", async () => {
    const view = await mount({ initial: uploadedStatus });
    view.respondWith((_url, method) => (method === "DELETE" ? Response.json({}, { status: 502 }) : Response.json(uploadedStatus)));
    view.resetButton("city").click();
    await flush();
    await flush();
    await flush();
    expect(view.requests.map((request) => request.method)).toEqual(["DELETE", "GET"]);
    expect(view.statusLine()).toBe("Unclear whether the change was saved. Load status");
  });

  test("a reset whose answer was lost after the commit reports the reset", async () => {
    const view = await mount({ initial: uploadedStatus });
    view.respondWith((_url, method) => {
      if (method === "DELETE") throw new TypeError("connection reset");
      return Response.json(bundledStatus);
    });
    view.resetButton("city").click();
    await flush();
    await flush();
    await flush();
    expect(view.statusLine()).toBe("Reset. Places use the bundled snapshot again.");
  });
});
