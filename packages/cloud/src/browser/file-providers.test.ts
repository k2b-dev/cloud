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
import {
  FILE_PROVIDER_NAME_CONFLICT,
  FileProviderContextListInputSchema,
  FileProviderListDataSchema,
  FileProviderListInputSchema,
  FileProviderReadInputSchema,
  FileProviderSaveDataSchema,
  FileProviderSaveInputSchema,
} from "../contracts/file-provider";
import {
  eachLimited,
  entryProblem,
  FileProviderError,
  type FileProviderSource,
  fileProviderSources,
  isSaveableName,
  listProviderFolder,
  loadFileProviders,
  nextFreeName,
  providerIcon,
  readProviderFile,
  readSaveSource,
  safeFileName,
  saveableName,
  saveProviderFile,
  verifiedMediaType,
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
  context: false,
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
      { appId: "alpha", name: "Alpha", icon: "ti ti-folders", list: "folder.list", context: false, read: "file.read", maxBytes: 1024 },
      { appId: "zeta", name: "Zeta", icon: "ti ti-folders", list: "folder.list", context: false, read: "file.read", maxBytes: 2048 },
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

  test("a catalog refusal keeps its status, so choosing can tell a visitor without providers from a failed load", async () => {
    for (const status of [401, 403]) {
      const refusal = loadFileProviders({ locale: "en", fetch: async () => json({ code: "UNAUTHORIZED", message: "No" }, status) });
      await expect(refusal).rejects.toMatchObject({ status });
    }
  });

  test("only Tabler icon classes from other apps reach the page", () => {
    expect(providerIcon("ti ti-home", "ti ti-file")).toBe("ti ti-home");
    expect(providerIcon("fixed inset-0 z-50", "ti ti-file")).toBe("ti ti-file");
    expect(providerIcon(undefined, "ti ti-file")).toBe("ti ti-file");
  });
});

describe("discovering where files can be saved", () => {
  const save = (maxBytes: number) => ({
    title: "Save",
    description: "Save one new file.",
    input: FileProviderSaveInputSchema,
    data: FileProviderSaveDataSchema,
    openWorld: false,
    destructive: false,
    idempotency: "required" as const,
    stream: {
      direction: "write" as const,
      maxBytes,
      write: async () => ({ data: {} }),
      status: async () => ({ state: "open" as const }),
      abort: async () => undefined,
    },
    run,
  });
  const saver = (appId: string, saveAction: ReturnType<typeof save>) =>
    app(
      appId,
      appId,
      defineCapabilities({
        protocolVersion: 2,
        queries: { "folder.list": list, "file.read": read(1024) },
        actions: { "file.save": saveAction },
        fileProvider: { list: "folder.list", read: "file.read", save: "file.save" },
      }),
    );

  test("a provider with a fitting save names it with its write limit; one that does not fit stays a source to choose from", () => {
    const odd = saver("odd", save(64));
    // A manifest from another release whose save has no write stream: Core would drop it, this reader drops only save.
    odd.manifest = { ...odd.manifest, actions: odd.manifest.actions.map(({ stream: _stream, ...action }) => action) };
    const [good, broken] = fileProviderSources([saver("good", save(2048)), odd], "en");
    expect(good?.save).toEqual({ id: "file.save", maxBytes: 2048 });
    expect(broken?.appId).toBe("odd");
    expect(broken?.save).toBeUndefined();
    expect(fileProviderSources([providerApp("read-only", "Read only")], "en")[0]?.save).toBeUndefined();
  });
});

describe("naming a saved file", () => {
  test("keeps a usable name and repairs one no provider takes", () => {
    expect(saveableName("Q3 report.pdf")).toBe("Q3 report.pdf");
    expect(saveableName("../etc/passwd")).toBe(".._etc_passwd");
    expect(saveableName("a\\b\u0007c")).toBe("a_b_c");
    expect(saveableName("  ")).toBe("file");
    expect(saveableName("..")).toBe("file");
    expect(saveableName("x".repeat(300))).toHaveLength(255);
    expect(isSaveableName("ok.txt")).toBe(true);
    expect(isSaveableName("a/b")).toBe(false);
  });

  test("a conflict suggests the next number before the extension", () => {
    expect(nextFreeName("Report.pdf")).toBe("Report (2).pdf");
    expect(nextFreeName("Report (2).pdf")).toBe("Report (3).pdf");
    expect(nextFreeName("README")).toBe("README (2)");
    expect(nextFreeName(".env")).toBe(".env (2)");
    expect(nextFreeName("archive.tar.gz")).toBe("archive.tar (2).gz");
    const long = nextFreeName(`${"x".repeat(250)}.pdf`);
    expect(long).toHaveLength(255);
    expect(long.endsWith(" (2).pdf")).toBe(true);
  });
});

describe("reading what a consumer saves", () => {
  test("a Blob keeps its bytes and gets a media type the contract takes", async () => {
    const blob = await readSaveSource({ name: "a.txt", content: new Blob(["hi"], { type: "text/plain;charset=utf-8" }) }, { maxBytes: 10 });
    expect(await blob.text()).toBe("hi");
    // Bun adds a charset to text types; the Action input drops parameters either way.
    expect(blob.type).toStartWith("text/plain");
    const opaque = await readSaveSource({ name: "a", content: new Blob(["hi"]) }, { maxBytes: 10 });
    expect(opaque.type).toBe("application/octet-stream");
    await expect(readSaveSource({ name: "a", content: new Blob(["too long"]) }, { maxBytes: 2 })).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
    });
  });

  test("a URL is read with the session, with progress, and the response type", async () => {
    const requests: RequestInit[] = [];
    const progress: [number, number][] = [];
    const blob = await readSaveSource(
      { name: "a.pdf", content: "/api/mail/attachments/1" },
      {
        maxBytes: 10,
        fetch: async (_url, init) => {
          requests.push(init ?? {});
          return new Response("%PDF", { headers: { "content-type": "application/pdf", "content-length": "4" } });
        },
        onProgress: (loaded, total) => progress.push([loaded, total]),
      },
    );
    expect(await blob.text()).toBe("%PDF");
    expect(blob.type).toBe("application/pdf");
    expect(requests[0]?.credentials).toBe("same-origin");
    expect(progress).toEqual([
      [0, 4],
      [4, 4],
    ]);
  });

  test("never holds more than the limit: a known size or content-length refuses early, a growing body is cancelled", async () => {
    let fetched = 0;
    const count = async () => {
      fetched++;
      return new Response("x");
    };
    await expect(readSaveSource({ name: "a", content: "/big", size: 11 }, { maxBytes: 10, fetch: count })).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
    });
    expect(fetched).toBe(0);

    let pulls = 0;
    const endless = () =>
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(4));
        },
      });
    const announced = readSaveSource(
      { name: "a", content: "/big" },
      { maxBytes: 10, fetch: async () => new Response(endless(), { headers: { "content-length": "40" } }) },
    );
    await expect(announced).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    pulls = 0;
    const growing = readSaveSource({ name: "a", content: "/big" }, { maxBytes: 10, fetch: async () => new Response(endless()) });
    await expect(growing).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    expect(pulls).toBeLessThan(6);
  });

  test("a refused or failed read says so with its status", async () => {
    const refused = readSaveSource(
      { name: "a", content: "/gone" },
      { maxBytes: 10, fetch: async () => new Response("no", { status: 403 }) },
    );
    await expect(refused).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE", status: 403 });
    const broken = readSaveSource(
      { name: "a", content: "/down" },
      {
        maxBytes: 10,
        fetch: async () => {
          throw new TypeError("network");
        },
      },
    );
    await expect(broken).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE", status: 503 });
  });
});

describe("saving into a provider", () => {
  const drive: FileProviderSource = { ...provider, save: { id: "file.save", maxBytes: 100 } };
  const writeDescriptor = (size: number) => ({
    id: "sealed-write",
    direction: "write",
    name: "a.txt",
    mediaType: "text/plain",
    size,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  /** Answers the save Action and the stream verbs; `write` decides how the write ends, `status` how status and abort answer. */
  const transport = (write: (body: string) => Response | Promise<Response>, status?: (verb: string) => Response) => {
    const calls: { url: string; key: string | null; input?: unknown }[] = [];
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const path = String(url);
      if (path.endsWith("/streams/write")) {
        calls.push({ url: path, key: headers.get("x-cloud-stream-id") });
        return write(await new Response(init?.body).text());
      }
      if (path.endsWith("/streams/status") || path.endsWith("/streams/abort")) {
        calls.push({ url: path, key: headers.get("x-cloud-stream-id") });
        return status?.(path.split("/").at(-1)!) ?? json({ state: "open" });
      }
      const { input } = JSON.parse(String(init?.body)) as { input: { size: number } };
      calls.push({ url: path, key: headers.get("idempotency-key"), input });
      return json({ data: {}, stream: writeDescriptor(input.size) });
    };
    return { calls, fetch };
  };
  const done = (name: string, size: number) =>
    json({ data: { file: { id: `id:${name}`, name, size } }, links: [{ rel: "open", href: "/app/drive?path=Docs" }] });

  test("opens the save Action with an idempotency key, writes the bytes, and returns the file with its link", async () => {
    const { calls, fetch } = transport((body) => done("a.txt", body.length));
    const saved = await saveProviderFile(
      drive,
      { parent: "docs", name: "a.txt", body: new Blob(["hello"], { type: "text/plain" }), idempotencyKey: "key-1" },
      { locale: "en", fetch },
    );
    expect(saved).toEqual({ id: "id:a.txt", name: "a.txt", size: 5, href: "/app/drive?path=Docs" });
    expect(calls).toEqual([
      {
        url: "/api/capabilities/v1/actions/drive/file.save",
        key: "key-1",
        input: { parent: "docs", name: "a.txt", mediaType: "text/plain", size: 5 },
      },
      { url: "/api/capabilities/v1/streams/write", key: "sealed-write" },
    ]);
  });

  test("a taken name fails with the contract code, from the Action or from the write", async () => {
    const conflict = () => json({ code: FILE_PROVIDER_NAME_CONFLICT, message: "Taken" }, 409);
    const atWrite = transport(conflict);
    const body = new Blob(["hello"]);
    const input = { parent: "docs", name: "a.txt", body, idempotencyKey: "key-1" };
    await expect(saveProviderFile(drive, input, { locale: "en", fetch: atWrite.fetch })).rejects.toMatchObject({
      code: FILE_PROVIDER_NAME_CONFLICT,
      status: 409,
    });
    const atAction = async () => conflict();
    await expect(saveProviderFile(drive, input, { locale: "en", fetch: atAction })).rejects.toMatchObject({
      code: FILE_PROVIDER_NAME_CONFLICT,
    });
    // Storage that is full keeps its own code, even with 409.
    const full = async () => json({ code: "insufficient_space", message: "Full" }, 409);
    await expect(saveProviderFile(drive, input, { locale: "en", fetch: full })).rejects.toMatchObject({ code: "insufficient_space" });
  });

  test("refuses a body above the write limit before asking the provider", async () => {
    const { calls, fetch } = transport(() => done("a", 0));
    const big = { parent: "docs", name: "a", body: new Blob([new Uint8Array(101)]), idempotencyKey: "k" };
    await expect(saveProviderFile(drive, big, { locale: "en", fetch })).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    expect(calls).toHaveLength(0);
  });

  test("a write whose answer was lost asks the stream's status before it fails", async () => {
    const lost = transport(
      () => {
        throw new TypeError("network");
      },
      () => json({ state: "completed", result: { data: { file: { id: "id:a", name: "a.txt", size: 5 } } } }),
    );
    const input = { parent: "docs", name: "a.txt", body: new Blob(["hello"]), idempotencyKey: "k" };
    expect(await saveProviderFile(drive, input, { locale: "en", fetch: lost.fetch })).toEqual({ id: "id:a", name: "a.txt", size: 5 });
    expect(lost.calls.map((call) => call.url.split("/").at(-1))).toEqual(["file.save", "write", "status"]);

    const open = transport(() => {
      throw new TypeError("network");
    });
    await expect(saveProviderFile(drive, input, { locale: "en", fetch: open.fetch })).rejects.toMatchObject({ code: "APP_UNAVAILABLE" });
  });

  test("a write that Core reports as broken off asks the stream's status before it fails", async () => {
    const input = { parent: "docs", name: "a.txt", body: new Blob(["hello"]), idempotencyKey: "k" };
    const completed = () => json({ state: "completed", result: { data: { file: { id: "id:a", name: "a.txt", size: 5 } } } });
    const interrupted = (code: string, status: number) => () =>
      json({ code, message: "Transfer interrupted; inspect write status before retrying" }, status);
    // Files committed the bytes, but its answer never reached Core.
    const lost = transport(interrupted("STREAM_FAILED", 502), completed);
    expect(await saveProviderFile(drive, input, { locale: "en", fetch: lost.fetch })).toEqual({ id: "id:a", name: "a.txt", size: 5 });
    expect(lost.calls.map((call) => call.url.split("/").at(-1))).toEqual(["file.save", "write", "status"]);

    // Still open: the write keeps its own code.
    const late = transport(interrupted("DEADLINE_EXCEEDED", 504));
    await expect(saveProviderFile(drive, input, { locale: "en", fetch: late.fetch })).rejects.toMatchObject({
      code: "DEADLINE_EXCEEDED",
      status: 504,
    });
    expect(late.calls.map((call) => call.url.split("/").at(-1))).toEqual(["file.save", "write", "status"]);

    // A provider's own answer is final and needs no status.
    const full = transport(() => json({ code: "insufficient_space", message: "Full" }, 507), completed);
    await expect(saveProviderFile(drive, input, { locale: "en", fetch: full.fetch })).rejects.toMatchObject({ code: "insufficient_space" });
    expect(full.calls.map((call) => call.url.split("/").at(-1))).toEqual(["file.save", "write"]);
  });

  test("a status that refuses keeps its code, so a taken name still asks for another", async () => {
    const input = { parent: "docs", name: "a.txt", body: new Blob(["hello"]), idempotencyKey: "k" };
    const broken = () => {
      throw new TypeError("network");
    };
    const taken = transport(broken, () => json({ code: FILE_PROVIDER_NAME_CONFLICT, message: "Taken" }, 409));
    await expect(saveProviderFile(drive, input, { locale: "en", fetch: taken.fetch })).rejects.toMatchObject({
      code: FILE_PROVIDER_NAME_CONFLICT,
      status: 409,
    });
    const forbidden = transport(broken, () => json({ code: "forbidden", message: "No" }, 403));
    await expect(saveProviderFile(drive, input, { locale: "en", fetch: forbidden.fetch })).rejects.toMatchObject({
      code: "forbidden",
      status: 403,
    });
  });

  test("Cancel while the status is looked up aborts the stream", async () => {
    const controller = new AbortController();
    const { calls, fetch } = transport(
      () => {
        throw new TypeError("network");
      },
      (verb) => {
        if (verb === "abort") return json({ state: "aborted" });
        controller.abort();
        throw new DOMException("Aborted", "AbortError");
      },
    );
    const input = { parent: "docs", name: "a.txt", body: new Blob(["hello"]), idempotencyKey: "k" };
    await expect(saveProviderFile(drive, input, { locale: "en", fetch, signal: controller.signal })).rejects.toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.map((call) => call.url.split("/").at(-1))).toEqual(["file.save", "write", "status", "abort"]);
  });

  test("reports an opened stream once, and never for an Action that failed", async () => {
    let streams = 0;
    const onStream = () => streams++;
    const input = { parent: "docs", name: "a.txt", body: new Blob(["hello"]), idempotencyKey: "k" };
    const { fetch } = transport((body) => done("a.txt", body.length));
    await saveProviderFile(drive, input, { locale: "en", fetch, onStream });
    expect(streams).toBe(1);
    const down = async () => json({ code: "APP_UNAVAILABLE", message: "Down" }, 503);
    await expect(saveProviderFile(drive, input, { locale: "en", fetch: down, onStream })).rejects.toMatchObject({ status: 503 });
    expect(streams).toBe(1);
  });

  test("a cancelled write aborts the stream, so the provider releases what it reserved", async () => {
    const controller = new AbortController();
    const { calls, fetch } = transport(() => {
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    });
    const input = { parent: "docs", name: "a.txt", body: new Blob(["hello"]), idempotencyKey: "k" };
    await expect(saveProviderFile(drive, input, { locale: "en", fetch, signal: controller.signal })).rejects.toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.map((call) => call.url.split("/").at(-1))).toEqual(["file.save", "write", "abort"]);
  });

  test("a provider that answers with another stream is not trusted with the bytes", async () => {
    const fetch = async () => json({ data: {}, stream: writeDescriptor(99) });
    const input = { parent: "docs", name: "a.txt", body: new Blob(["hello"]), idempotencyKey: "k" };
    await expect(saveProviderFile(drive, input, { locale: "en", fetch })).rejects.toMatchObject({ code: "INVALID_APP_RESPONSE" });
  });
});

describe("cleaning a provider's file names", () => {
  test("removes control characters, path separators, and bidi controls, so a name shows what it is", () => {
    expect(safeFileName("rechnung\u202Efdp.exe")).toBe("rechnungfdp.exe");
    expect(safeFileName("a\u2066b\u2069c\u200F.pdf")).toBe("abc.pdf");
    expect(safeFileName("../etc/passwd")).toBe("..etcpasswd");
    expect(safeFileName("C:\\temp\\x.txt")).toBe("C:tempx.txt");
    expect(safeFileName("line\nbreak\u0000\u009f.md")).toBe("linebreak.md");
    expect(safeFileName("  Report.pdf  ")).toBe("Report.pdf");
    expect(safeFileName("\u202E")).toBe("file");
    expect(safeFileName("..")).toBe("file");
  });

  test("keeps at most 255 UTF-8 bytes and the extension, without cutting a character in half", () => {
    const long = `${"ä".repeat(200)}.pdf`;
    const short = safeFileName(long);
    expect(new TextEncoder().encode(short).byteLength).toBeLessThanOrEqual(255);
    expect(short.endsWith(".pdf")).toBe(true);
    expect(short.startsWith("ää")).toBe(true);
    expect(short).not.toContain("\uFFFD");
    const emoji = safeFileName(`${"😀".repeat(70)}.txt`);
    expect(new TextEncoder().encode(emoji).byteLength).toBeLessThanOrEqual(255);
    expect([...emoji.slice(0, -4)].every((character) => character === "😀")).toBe(true);
  });

  test("a listed folder shows cleaned names", async () => {
    const page = await listProviderFolder(
      provider,
      {},
      {
        locale: "en",
        fetch: async () => json({ data: { writable: false, items: [file("a", 3, { name: "rechnung\u202Efdp.exe" })], next: null } }),
      },
    );
    expect(page.items[0]?.name).toBe("rechnungfdp.exe");
  });
});

describe("proving a file's type from its first bytes", () => {
  const bytes = (...values: (number | string)[]) =>
    new Uint8Array(values.flatMap((value) => (typeof value === "string" ? [...value].map((char) => char.charCodeAt(0)) : [value])));
  const pdf = bytes("%PDF-1.7");
  const png = bytes(0x89, "PNG\r\n", 0x1a, "\n");
  const zip = bytes("PK", 3, 4);
  const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

  test("provable types: the bytes decide, a claim they fit stays, another proven type replaces it", () => {
    expect(verifiedMediaType(pdf, "report.pdf", "application/pdf")).toBe("application/pdf");
    expect(verifiedMediaType(bytes(0xff, 0xd8, 0xff, 0xe0), "a.jpg", "image/jpg")).toBe("image/jpg");
    expect(verifiedMediaType(bytes("GIF89a"), "a.gif", undefined)).toBe("image/gif");
    expect(verifiedMediaType(bytes(0, 0, 0, 0x18, "ftypisom"), "a.mp4", "video/mp4")).toBe("video/mp4");
    expect(verifiedMediaType(zip, "letter.docx", DOCX)).toBe(DOCX);
    expect(verifiedMediaType(zip, "letter.docx", undefined)).toBe(DOCX);
    // A PNG that claims to be a PDF is a PNG, and a PDF target refuses it.
    expect(verifiedMediaType(png, "invoice.pdf", "application/pdf")).toBe("image/png");
    expect(verifiedMediaType(png, "invoice.pdf", "application/pdf", "application/pdf")).toBeUndefined();
    // Bytes that prove nothing never keep a provable claim.
    expect(verifiedMediaType(bytes("hello"), "a.pdf", "application/pdf")).toBe("application/octet-stream");
    expect(verifiedMediaType(bytes("<html>"), "letter.docx", DOCX)).toBe("application/octet-stream");
  });

  test("active content is never trusted from a claim or a name, unless the target names it explicitly", () => {
    expect(verifiedMediaType(bytes("<html>"), "page.html", "text/plain")).toBe("application/octet-stream");
    expect(verifiedMediaType(bytes("<html>"), "page.txt", "text/html")).toBe("application/octet-stream");
    expect(verifiedMediaType(bytes("<svg xmlns"), "a.svg", "image/svg+xml")).toBe("application/octet-stream");
    expect(verifiedMediaType(bytes("alert(1)"), "a.js", "text/javascript")).toBe("application/octet-stream");
    expect(verifiedMediaType(bytes("<?xml"), "feed.xml", "application/rss+xml")).toBe("application/octet-stream");
    expect(verifiedMediaType(bytes("<svg xmlns"), "a.svg", "image/svg+xml", "image/*,.svg")).toBe("image/svg+xml");
    expect(verifiedMediaType(bytes("<svg xmlns"), "a.svg", "image/svg+xml", ".svg")).toBe("image/svg+xml");
    expect(verifiedMediaType(bytes("<svg xmlns"), "a.svg", "image/svg+xml", "image/svg+xml")).toBe("image/svg+xml");
    // A name that fits an unrelated token never makes an active type accepted.
    expect(verifiedMediaType(bytes("<html>"), "notes.txt", "text/html", ".txt")).toBe("application/octet-stream");
    expect(verifiedMediaType(bytes("<html>"), "notes.txt", "text/html", ".html")).toBe("text/html");
    // An active type's own extensions and aliases name it, whatever type the extension maps to.
    expect(verifiedMediaType(bytes("alert(1)"), "script.js", "application/javascript", ".js")).toBe("application/javascript");
    expect(verifiedMediaType(bytes("alert(1)"), "script.js", "application/x-javascript", "text/javascript")).toBe(
      "application/x-javascript",
    );
    expect(verifiedMediaType(bytes("<html"), "page.xhtml", "application/xhtml+xml", ".xhtml")).toBe("application/xhtml+xml");
    expect(verifiedMediaType(bytes("<html"), "page.xhtml", "application/xhtml+xml", ".html")).toBeUndefined();
    expect(verifiedMediaType(bytes("<?xml"), "data.xml", "text/xml", ".xml")).toBe("text/xml");
    expect(verifiedMediaType(bytes("<html>"), "page.htm", "text/html", ".htm")).toBe("text/html");
    expect(verifiedMediaType(bytes("<svg xmlns"), "a.svg", "image/svg+xml", "image/*")).toBeUndefined();
    expect(verifiedMediaType(bytes("<html>"), "page.html", "text/plain", "text/*")).toBeUndefined();
    // Bytes that prove an image under an active claim are that image.
    expect(verifiedMediaType(png, "logo.svg", "image/svg+xml", "image/*")).toBe("image/png");
  });

  test("plain types keep the provider's declared type, as a hint for display", () => {
    expect(verifiedMediaType(bytes("plain"), "notes.txt", "text/plain")).toBe("text/plain");
    expect(verifiedMediaType(bytes("a,b"), "table.csv", "text/csv; charset=utf-8")).toBe("text/csv");
    expect(verifiedMediaType(bytes("# Notes"), "notes.md", "text/markdown")).toBe("text/markdown");
    expect(verifiedMediaType(bytes("{}"), "data.json", "application/json")).toBe("application/json");
    expect(verifiedMediaType(bytes("x"), "notes.txt", undefined)).toBe("text/plain");
    expect(verifiedMediaType(bytes("x"), "blob", undefined)).toBe("application/octet-stream");
    expect(verifiedMediaType(bytes("plain"), "notes.txt", "text/plain", "text/*")).toBe("text/plain");
  });

  test("image, PDF, audio, and video tokens take only bytes that prove a matching type", () => {
    expect(verifiedMediaType(pdf, "report.pdf", "application/pdf", ".pdf")).toBe("application/pdf");
    expect(verifiedMediaType(pdf, "report.png", "image/png", "image/*")).toBeUndefined();
    expect(verifiedMediaType(bytes("<html>"), "photo.png", "image/png", "image/png,image/jpeg")).toBeUndefined();
    expect(verifiedMediaType(bytes(0xff, 0xd8, 0xff), "photo.jpeg", "image/jpeg", ".jpeg")).toBe("image/jpeg");
    expect(verifiedMediaType(bytes("<html>"), "photo.bmp", "image/bmp", ".bmp")).toBeUndefined();
    expect(verifiedMediaType(bytes("<html>"), "track.aac", "audio/aac", ".aac")).toBeUndefined();
    expect(verifiedMediaType(bytes("BM", 0, 0), "photo.bmp", undefined, ".bmp")).toBe("image/bmp");
    // A real image under a plain claim still fits an image target, as the image it is.
    expect(verifiedMediaType(png, "photo.txt", "text/plain", "image/*")).toBe("image/png");
    // Other tokens take a file by its name or type.
    expect(verifiedMediaType(zip, "letter.docx", undefined, "image/*,.docx")).toBe(DOCX);
    expect(verifiedMediaType(zip, "letter.zip", undefined, "image/*,.docx")).toBeUndefined();
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
    expect(page).toEqual({ items: [file("a", 3)], next: "c2", writable: false });
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

  test("returns a File with the listed name, the type its bytes prove, and progress", async () => {
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
    // "hello" is no PDF: a provable type the bytes do not prove is only a hint.
    expect(result.type).toBe("application/octet-stream");
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

  test("cleans the name and takes the type from the first bytes, refusing content that does not fit accept", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const photo = reader(png, png.length, "image/png");
    const listed = file("photo", png.length, { name: "rechnung\u202Efdp.png", mediaType: "image/png" });
    const result = await readProviderFile(provider, listed, { locale: "en", fetch: photo.fetch, maxBytes: 100, accept: "image/*" });
    expect(result.name).toBe("rechnungfdp.png");
    expect(result.type).toBe("image/png");

    // A page claimed to be an image, with a fitting extension, is refused once its bytes are read.
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    const fake = reader(html, html.length, "image/png");
    const disguised = file("fake", html.length, { name: "photo.png", mediaType: "image/png" });
    await expect(
      readProviderFile(provider, disguised, { locale: "en", fetch: fake.fetch, maxBytes: 100, accept: "image/*" }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE", status: 415 });

    // Without accept the same bytes come back, as application/octet-stream instead of the claimed type.
    const plain = reader(html, html.length, "image/png");
    const kept = await readProviderFile(provider, disguised, { locale: "en", fetch: plain.fetch, maxBytes: 100 });
    expect(kept.type).toBe("application/octet-stream");
  });

  test("a read whose announced size the shared budget cannot take is refused before any byte moves", async () => {
    const { calls, fetch } = reader(new Uint8Array(8), 8);
    const sizes: number[] = [];
    const read = readProviderFile(provider, file("a", 1), {
      locale: "en",
      fetch,
      maxBytes: 100,
      reserve: (size) => {
        sizes.push(size);
        return false;
      },
    });
    await expect(read).rejects.toMatchObject({ code: "FILE_TOO_LARGE", status: 413 });
    expect(sizes).toEqual([8]);
    expect(calls).toHaveLength(1);
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

test("provider discovery detects explicit context support", () => {
  const contextual = app(
    "invoices",
    "Invoices",
    defineCapabilities({
      protocolVersion: 2,
      queries: { "folder.list": { ...list, input: FileProviderContextListInputSchema }, "file.read": read(1024) },
      fileProvider: { list: "folder.list", read: "file.read" },
    }),
  );
  expect(fileProviderSources([contextual, providerApp("drive", "Drive")], "en").map(({ appId, context }) => ({ appId, context }))).toEqual([
    { appId: "drive", context: false },
    { appId: "invoices", context: true },
  ]);
});

test("sends context on every supporting provider page and never sends it to another provider", async () => {
  const context = { refs: [{ type: "customers.customer", id: "c1" }] };
  for (const supports of [true, false]) {
    const calls: unknown[] = [];
    const caller = {
      locale: "en",
      fetch: async (_url: string | URL | Request, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body)).input);
        return json({ data: { writable: false, items: [], next: calls.length === 1 ? "page2" : null } });
      },
    };
    const source = { ...provider, context: supports };
    const first = await listProviderFolder(source, { parent: "docs", query: "invoice", context }, caller);
    await listProviderFolder(source, { parent: "docs", query: "invoice", context, cursor: first.next! }, caller);
    expect(calls).toEqual([
      { parent: "docs", query: "invoice", limit: 50, ...(supports ? { context } : {}) },
      { parent: "docs", query: "invoice", limit: 50, cursor: "page2", ...(supports ? { context } : {}) },
    ]);
  }
});
