import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { compileCapabilityManifest } from "../capabilities/testing";
import type { CapabilityCatalogApp } from "../capabilities/types";
import {
  type CapabilityDefinitions,
  type CapabilityInvocationResult,
  type CapabilityQueryDefinition,
  defineCapabilities,
} from "../contracts/capabilities";
import { FileProviderListDataSchema, FileProviderListInputSchema, FileProviderReadInputSchema } from "../contracts/file-provider";
import {
  eachLimited,
  entryProblem,
  FileProviderError,
  type FileProviderSource,
  fileProviderSources,
  listProviderFolder,
  loadFileProviders,
  providerIcon,
  readProviderFile,
} from "./file-providers";

const run = (): CapabilityInvocationResult<never> => ({ ok: false, error: { code: "INTERNAL", message: "Not invoked.", status: 500 } });
const list: CapabilityQueryDefinition = {
  title: "List",
  description: "List one folder.",
  input: FileProviderListInputSchema,
  data: FileProviderListDataSchema,
  openWorld: false,
  run,
};
const read = (maxBytes: number): CapabilityQueryDefinition => ({
  title: "Read",
  description: "Read one file.",
  input: FileProviderReadInputSchema,
  data: z.object({}).strict(),
  openWorld: false,
  stream: { direction: "read", maxBytes, read: async () => new Response("") },
  run,
});
const app = (appId: string, appName: string, definitions: CapabilityDefinitions): CapabilityCatalogApp => ({
  appId,
  appName,
  appIcon: "ti ti-folders",
  appDescription: "",
  manifest: compileCapabilityManifest(appId, definitions),
});
const providerApp = (appId: string, appName: string, maxBytes = 1024) =>
  app(
    appId,
    appName,
    defineCapabilities({
      protocolVersion: 2,
      queries: { "folder.list": list, "file.read": read(maxBytes) },
      fileProvider: { list: "folder.list", read: "file.read" },
    }),
  );

const provider: FileProviderSource = {
  appId: "drive",
  name: "Drive",
  icon: "ti ti-folders",
  list: "folder.list",
  read: "file.read",
  maxBytes: 1024,
};
const file = (id: string, size: number, extra: Record<string, unknown> = {}) => ({
  kind: "file" as const,
  id,
  name: `${id}.txt`,
  size,
  ...extra,
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const descriptor = (size: number, mediaType = "text/plain") => ({
  id: "sealed",
  direction: "read",
  name: "notes.txt",
  mediaType,
  size,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});

describe("file provider discovery", () => {
  test("keeps catalog apps with a usable list and read, sorted by name, with the read limit", () => {
    const plain = app("notes", "Notes", defineCapabilities({ protocolVersion: 2, queries: { "folder.list": list } }));
    const broken = providerApp("broken", "Broken");
    broken.manifest = { ...broken.manifest, queries: broken.manifest.queries.filter((query) => query.localId !== "file.read") };
    const sources = fileProviderSources([providerApp("zeta", "Zeta", 2048), plain, broken, providerApp("alpha", "Alpha")], "en");
    expect(sources).toEqual([
      { appId: "alpha", name: "Alpha", icon: "ti ti-folders", list: "folder.list", read: "file.read", maxBytes: 1024 },
      { appId: "zeta", name: "Zeta", icon: "ti ti-folders", list: "folder.list", read: "file.read", maxBytes: 2048 },
    ]);
  });

  test("reads every catalog page and sends the page locale", async () => {
    const requests: string[] = [];
    const pages = [
      { protocolVersion: 2, apps: [providerApp("alpha", "Alpha")], page: { hasMore: true, nextCursor: "a" } },
      { protocolVersion: 2, apps: [providerApp("beta", "Beta")], page: { hasMore: false } },
    ];
    const sources = await loadFileProviders({
      locale: "de",
      fetch: async (url, init) => {
        requests.push(`${url} ${new Headers(init?.headers).get("x-cloud-locale")}`);
        return json(pages[requests.length - 1]);
      },
    });
    expect(sources.map((source) => source.appId)).toEqual(["alpha", "beta"]);
    expect(requests).toEqual(["/api/capabilities/v1/catalog?limit=25 de", "/api/capabilities/v1/catalog?cursor=a&limit=25 de"]);
  });

  test("a failed catalog read is an error, not an empty provider list", async () => {
    const failure = loadFileProviders({ locale: "en", fetch: async () => json({ code: "APP_UNAVAILABLE", message: "Down" }, 503) });
    await expect(failure).rejects.toMatchObject({ code: "APP_UNAVAILABLE", status: 503 });
  });

  test("only Tabler icon classes from other apps reach the page", () => {
    expect(providerIcon("ti ti-home", "ti ti-file")).toBe("ti ti-home");
    expect(providerIcon("fixed inset-0 z-50", "ti ti-file")).toBe("ti ti-file");
    expect(providerIcon(undefined, "ti ti-file")).toBe("ti ti-file");
  });
});

describe("browsing a provider", () => {
  test("asks for one page of a folder with the chooser's page size", async () => {
    let body: unknown;
    const page = await listProviderFolder(
      provider,
      { parent: "f1", query: "inv", cursor: "c1" },
      {
        locale: "en",
        fetch: async (url, init) => {
          expect(String(url)).toBe("/api/capabilities/v1/queries/drive/folder.list");
          body = JSON.parse(String(init?.body));
          return json({ data: { writable: false, items: [file("a", 3)], next: "c2" } });
        },
      },
    );
    expect(body).toEqual({ input: { parent: "f1", query: "inv", cursor: "c1", limit: 50 } });
    expect(page).toEqual({ items: [file("a", 3)], next: "c2" });
  });

  test("keeps the provider's status, so the chooser can tell no access from an outage", async () => {
    const forbidden = listProviderFolder(
      provider,
      {},
      { locale: "en", fetch: async () => json({ code: "FORBIDDEN", message: "No" }, 403) },
    );
    await expect(forbidden).rejects.toMatchObject({ status: 403 });
  });

  test("disables files outside accept or above the effective limit, never folders", () => {
    expect(entryProblem(file("a", 10, { name: "photo.png", mediaType: "image/png" }), "image/*", 100)).toBeUndefined();
    expect(entryProblem(file("a", 10, { name: "report.pdf" }), "image/*", 100)).toBe("type");
    expect(entryProblem(file("a", 10, { name: "report.pdf" }), ".pdf", 100)).toBeUndefined();
    expect(entryProblem(file("a", 101), undefined, 100)).toBe("size");
    expect(entryProblem({ kind: "folder", id: "f", name: "Folder" }, "image/*", 0)).toBeUndefined();
  });
});

describe("reading a provider file", () => {
  const reader = (bytes: Uint8Array<ArrayBuffer>, announced: number, mediaType?: string) => {
    const calls: string[] = [];
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(String(url));
      if (String(url).endsWith("/streams/read")) {
        expect(new Headers(init?.headers).get("x-cloud-stream-id")).toBe("sealed");
        return new Response(bytes);
      }
      return json({ data: {}, stream: descriptor(announced, mediaType) });
    };
    return { calls, fetch };
  };

  test("returns a File with the listed name, the stream's media type, and progress", async () => {
    const { calls, fetch } = reader(new TextEncoder().encode("hello"), 5, "application/pdf");
    const progress: number[] = [];
    const result = await readProviderFile(provider, file("notes", 5, { updatedAt: "2026-10-01T10:00:00Z" }), {
      locale: "en",
      fetch,
      maxBytes: 10,
      onProgress: (loaded) => progress.push(loaded),
    });
    expect(calls).toEqual(["/api/capabilities/v1/queries/drive/file.read", "/api/capabilities/v1/streams/read"]);
    expect(result.name).toBe("notes.txt");
    expect(result.type).toBe("application/pdf");
    expect(result.lastModified).toBe(Date.parse("2026-10-01T10:00:00Z"));
    expect(await result.text()).toBe("hello");
    expect(progress).toEqual([0, 5]);
  });

  test("refuses a file above the effective limit before transferring it", async () => {
    const { calls, fetch } = reader(new Uint8Array(20), 20);
    await expect(readProviderFile(provider, file("big", 20), { locale: "en", fetch, maxBytes: 10 })).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
    });
    expect(calls).toHaveLength(1);
  });

  test("refuses a read whose media type no longer matches accept before transferring it", async () => {
    const { calls, fetch } = reader(new TextEncoder().encode("hello"), 5, "text/plain");
    const listed = file("photo", 5, { name: "photo.png", mediaType: "image/png" });
    const read = readProviderFile(provider, listed, { locale: "en", fetch, maxBytes: 10, accept: "image/*" });
    await expect(read).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE", status: 415 });
    expect(calls).toHaveLength(1);
  });

  test("rejects a body that is longer or shorter than announced", async () => {
    const longer = reader(new Uint8Array(8), 5);
    await expect(readProviderFile(provider, file("a", 5), { locale: "en", fetch: longer.fetch, maxBytes: 10 })).rejects.toBeInstanceOf(
      FileProviderError,
    );
    const shorter = reader(new Uint8Array(3), 5);
    await expect(readProviderFile(provider, file("a", 5), { locale: "en", fetch: shorter.fetch, maxBytes: 10 })).rejects.toMatchObject({
      message: "The file ended early",
    });
  });

  test("a cancelled read stops the transfer", async () => {
    const abort = new AbortController();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(1));
        if (pulls === 2) abort.abort();
      },
    });
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).endsWith("/streams/read")) return json({ data: {}, stream: descriptor(100) });
      return new Response(body, { signal: init?.signal } as ResponseInit);
    };
    const read = readProviderFile(provider, file("a", 100), { locale: "en", fetch, maxBytes: 1000, signal: abort.signal });
    await expect(read).rejects.toBeDefined();
    expect(pulls).toBeLessThan(100);
  });

  test("runs at most the given number of reads at once", async () => {
    let running = 0;
    let peak = 0;
    await eachLimited([1, 2, 3, 4, 5], 2, async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
    });
    expect(peak).toBe(2);
  });
});
