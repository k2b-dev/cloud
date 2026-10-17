import { afterEach, expect, test } from "bun:test";
import { currentLibrary } from "../../test/future-capability-manifest";
import type { CapabilityCatalog, CapabilitySearchTagManifest } from "../contracts/capabilities";
import { LOCALE_HEADER } from "../shared/locale";
import { loadCloudComposerCatalog } from "./composer-catalog";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const note = { tag: "note", title: "Notizen", description: "Notizen durchsuchen", aliases: ["notiz", "markdown"] };
const app = (appId: string, tags: CapabilitySearchTagManifest[] = [note]): CapabilityCatalog["apps"][number] => {
  const manifest = structuredClone(currentLibrary.manifest);
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
  expect(requests.every((request) => request.signal === undefined)).toBe(true);
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
