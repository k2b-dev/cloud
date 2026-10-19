import { afterEach, expect, mock, test } from "bun:test";
import { currentLibrary } from "../../test/future-capability-manifest";
import type { CapabilityCatalog, CapabilitySearchTagManifest } from "../contracts/capabilities";
import { LOCALE_HEADER } from "../shared/locale";
import type { CloudComposerCatalog } from "./composer-catalog";

let navigation: { apps: { id: string }[]; appId?: string } | undefined;
mock.module("../ssr/shell-data", () => ({ readShellData: () => navigation }));
const { createCloudComposerCatalog, loadCloudComposerCatalog } = await import("./composer-catalog");

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  navigation = undefined;
});
const note = { tag: "note", title: "Notizen", description: "Notizen durchsuchen", aliases: ["notiz", "markdown"] };
const app = (appId: string, tags: CapabilitySearchTagManifest[] = [note], readers = true): CapabilityCatalog["apps"][number] => {
  const manifest = structuredClone(currentLibrary.manifest);
  if (!readers) manifest.types = manifest.types.map(({ reader: _reader, ...type }) => type);
  const search = manifest.queries.find((query) => query.universalSearch)!;
  return {
    appId,
    appName: `App ${appId}`,
    appIcon: "ti ti-notebook",
    appDescription: "Searchable content",
    manifest: {
      ...manifest,
      appId,
      queries: [
        ...manifest.queries.filter((query) => !query.universalSearch),
        { ...search, universalSearch: { tags } },
        { ...search, localId: "search-again", universalSearch: { tags: [{ ...note, title: "Duplicate" }] } },
      ],
    },
  };
};
const page = (apps: CapabilityCatalog["apps"], nextCursor?: string): CapabilityCatalog => ({
  protocolVersion: 2,
  apps,
  page: nextCursor ? { hasMore: true, nextCursor } : { hasMore: false },
});
const stubFetch = (fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) => {
  globalThis.fetch = Object.assign(fetcher, { preconnect: originalFetch.preconnect });
};

test("shares one paginated catalog load across concurrent and later calls for a locale", async () => {
  const requests: Array<{ url: string; headers: Headers; signal?: AbortSignal | null }> = [];
  stubFetch(async (input, init) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers), signal: init?.signal });
    return Response.json(requests.length === 1 ? page([app("library")], "library") : page([app("notebooks")]));
  });
  const first = loadCloudComposerCatalog("de-CH");
  const concurrent = loadCloudComposerCatalog("de-CH");
  expect(concurrent).toBe(first);
  const catalog = await first;
  expect(await concurrent).toBe(catalog);
  expect(await loadCloudComposerCatalog("de-CH")).toBe(catalog);
  expect(requests.map((request) => request.url)).toEqual([
    "/api/capabilities/v1/catalog?limit=25",
    "/api/capabilities/v1/catalog?cursor=library&limit=25",
  ]);
  expect(requests.every((request) => request.headers.get(LOCALE_HEADER) === "de-CH")).toBe(true);
  // Each page has its own deadline, so a request that never answers ends as a failure the next opening retries.
  expect(requests.every((request) => request.signal instanceof AbortSignal && !request.signal.aborted)).toBe(true);
  expect(catalog.tags.map((tag) => tag.appId)).toEqual(["library", "notebooks"]);
});

test("keeps localized tag and app metadata, with the first app/tag occurrence winning", async () => {
  stubFetch(async () => Response.json(page([app("library", [note, { tag: "book", title: "Bücher", description: "Bücher suchen" }])])));
  expect((await loadCloudComposerCatalog("de-DE")).tags).toEqual([
    { appId: "library", appName: "App library", appIcon: "ti ti-notebook", ...note },
    {
      appId: "library",
      appName: "App library",
      appIcon: "ti ti-notebook",
      tag: "book",
      title: "Bücher",
      description: "Bücher suchen",
      aliases: [],
    },
  ]);
});

test("forgets a failed load and retries only on the next call", async () => {
  let requests = 0;
  stubFetch(async () => {
    requests++;
    return requests === 1
      ? Response.json({ code: "APP_UNAVAILABLE", message: "Catalog unavailable" }, { status: 503 })
      : Response.json(page([app("library")]));
  });
  await expect(loadCloudComposerCatalog("fr-CH")).rejects.toThrow("Catalog unavailable");
  expect(requests).toBe(1);
  expect((await loadCloudComposerCatalog("fr-CH")).tags).toHaveLength(1);
  expect(requests).toBe(2);
});

test("keeps separate catalog loads for different locales", async () => {
  const locales: Array<string | null> = [];
  stubFetch(async (_input, init) => {
    const locale = new Headers(init?.headers).get(LOCALE_HEADER);
    locales.push(locale);
    return Response.json(page([app("library", [{ ...note, title: locale! }])]));
  });
  const [english, french] = await Promise.all([loadCloudComposerCatalog("en-GB"), loadCloudComposerCatalog("fr-FR")]);
  expect(locales).toEqual(["en-GB", "fr-FR"]);
  expect(english.tags[0]?.title).toBe("en-GB");
  expect(french.tags[0]?.title).toBe("fr-FR");
});

test("rejects a non-monotonic catalog cursor", async () => {
  let requests = 0;
  stubFetch(async () => {
    requests++;
    return Response.json(page([], "library"));
  });
  await expect(loadCloudComposerCatalog("it-CH")).rejects.toThrow("cursor");
  expect(requests).toBe(2);
});

test("leaves out the tags of apps without a resource reader, whose pickers could show nothing", async () => {
  stubFetch(async () => Response.json(page([app("library"), app("accounts", [{ ...note, tag: "account", title: "Konten" }], false)])));
  expect((await loadCloudComposerCatalog("nl-BE")).tags.map((tag) => tag.appId)).toEqual(["library"]);
});

test("a composer catalog loads once per opening and lets only typed unscoped text wait for it", async () => {
  const loads: Array<(catalog: CloudComposerCatalog) => void> = [];
  const catalog = createCloudComposerCatalog(
    () =>
      new Promise((resolve) => {
        loads.push(resolve);
      }),
  );
  let waited = false;
  // The overview and a scoped search answer at once; both belong to the opening whose load has just started.
  await catalog.ready("", { opening: 1 }, "de");
  await catalog.ready("q3", { opening: 1, scope: "skill" }, "de");
  const typed = catalog.ready("notiz", { opening: 1 }, "de").then(() => {
    waited = true;
  });
  await Promise.resolve();
  expect(loads).toHaveLength(1);
  expect(waited).toBe(false);
  const tag = { appId: "library", appName: "Library", appIcon: "ti ti-book", tag: "note", title: "Notizen", description: "", aliases: [] };
  loads[0]!({ tags: [tag], commands: [] });
  await typed;
  expect(catalog.tags()).toEqual([tag]);
  const next = catalog.ready("notiz", { opening: 2 }, "de");
  expect(loads).toHaveLength(2);
  loads[1]!({ tags: [tag], commands: [] });
  await next;
});

test("after a failed load no search waits again, and the tags it had stay", async () => {
  const tag = { appId: "library", appName: "Library", appIcon: "ti ti-book", tag: "note", title: "Notizen", description: "", aliases: [] };
  const answers: Array<() => Promise<CloudComposerCatalog>> = [
    () => Promise.resolve({ tags: [tag], commands: [] }),
    () => Promise.reject(new Error("Offline")),
    // A stalled retry must not hold the list.
    () => new Promise(() => {}),
  ];
  const catalog = createCloudComposerCatalog(() => answers.shift()!());
  await catalog.ready("notiz", { opening: 1 }, "de");
  await catalog.ready("notiz", { opening: 2 }, "de");
  expect(catalog.tags()).toEqual([tag]);
  await catalog.ready("notiz", { opening: 3 }, "de");
  expect(answers).toHaveLength(0);
});

const commandApp = (appId: string, required = false) => {
  const entry = app(appId, [], false);
  entry.manifest.commands = [
    {
      localId: "task.compose",
      title: "Neue Aufgabe",
      description: "Eine Aufgabe öffnen.",
      icon: "ti ti-checkbox",
      keywords: ["task", "Aufgabe"],
      path: `/app/${appId}`,
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        ...(required ? { required: ["title"] } : {}),
        additionalProperties: false,
      },
    },
  ];
  return entry;
};

test("two composers share every catalog page across openings; Commands require navigation and empty input, exclude this app, and need no reader", async () => {
  navigation = { apps: [{ id: "spaces" }, { id: "assistant" }, { id: "required" }], appId: "assistant" };
  let requests = 0;
  stubFetch(async () => {
    requests++;
    return Response.json(
      requests === 1
        ? page([commandApp("assistant"), commandApp("hidden"), commandApp("required", true)], "required")
        : page([commandApp("spaces")]),
    );
  });
  const one = createCloudComposerCatalog(),
    two = createCloudComposerCatalog();
  await Promise.all([one.ready("task", { opening: 1 }, "de-AT"), two.ready("task", { opening: 1 }, "de-AT")]);
  await one.ready("task", { opening: 2 }, "de-AT");
  await two.ready("task", { opening: 3 }, "de-AT");
  expect(requests).toBe(2);
  expect(one.state()).toBe("ready");
  expect(one.commands()).toEqual(two.commands());
  expect(one.commands()).toEqual([
    {
      id: "spaces.task.compose",
      appId: "spaces",
      appName: "App spaces",
      appIcon: "ti ti-notebook",
      title: "Neue Aufgabe",
      description: "Eine Aufgabe öffnen.",
      icon: "ti ti-checkbox",
      keywords: ["task", "Aufgabe"],
      input: {},
    },
  ]);
  expect(one.tags()).toEqual([]);
});

test("catalog retry opening moves failed → loading → ready and sends exactly one fresh request", async () => {
  let requests = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  stubFetch(async () => {
    requests++;
    if (requests === 1) return Response.json({ message: "Offline" }, { status: 503 });
    await gate;
    return Response.json(page([]));
  });
  const catalog = createCloudComposerCatalog();
  expect(catalog.state()).toBe("loading");
  await catalog.ready("task", { opening: 1 }, "en-AU");
  expect(catalog.state()).toBe("failed");
  await catalog.ready("", { opening: 2 }, "en-AU");
  await catalog.ready("task", { opening: 2 }, "en-AU");
  expect(catalog.state()).toBe("loading");
  expect(requests).toBe(2);
  release();
  for (let n = 0; n < 20; n++) await Promise.resolve();
  expect(catalog.state()).toBe("ready");
  expect(requests).toBe(2);
});

test("global Commands use the same navigation and empty-input rule, retaining the current app", async () => {
  const { loadSearchCommands } = await import("./search-commands");
  navigation = { apps: [{ id: "assistant" }, { id: "spaces" }, { id: "required" }], appId: "assistant" };
  stubFetch(async () =>
    Response.json(page([commandApp("hidden"), commandApp("required", true), commandApp("spaces"), commandApp("assistant")])),
  );
  const commands = await loadSearchCommands("de", new AbortController().signal);
  expect(commands.map((command) => command.id)).toEqual(["spaces.task.compose", "assistant.task.compose"]);
  navigation = undefined;
  expect(await loadSearchCommands("de", new AbortController().signal)).toEqual([]);
});
