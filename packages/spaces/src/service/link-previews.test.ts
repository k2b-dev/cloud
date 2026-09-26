import { describe, expect, test } from "bun:test";
import { parseGitHubLink } from "../lib/link-targets";
import { fetchGitHubPreview, type PreviewStore, resolveLinkPreviews } from "./link-previews";

const memoryStore = () => {
  const entries = new Map<string, { value: string; ttl: number }>();
  const store: PreviewStore = {
    get: async (key) => entries.get(key)?.value ?? null,
    set: async (key, value, ttl) => {
      entries.set(key, { value, ttl });
    },
  };
  return { store, entries };
};

const githubFetch = (status: number, body: unknown, headers: Record<string, string> = {}) => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({ url: String(input), headers });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  }) as unknown as typeof fetch;
  return { fetchMock, calls };
};

const openBudget = { check: async () => ({ limited: false, remaining: 1, resetIn: 0 }) };

describe("parseGitHubLink", () => {
  test("recognises issue and pull request URLs and nothing else", () => {
    expect(parseGitHubLink("https://github.com/k2b-dev/cloud/issues/263")).toEqual({ owner: "k2b-dev", repo: "cloud", number: 263 });
    expect(parseGitHubLink("https://github.com/k2b-dev/cloud/pull/12#discussion_r1")).toEqual({
      owner: "k2b-dev",
      repo: "cloud",
      number: 12,
    });
    expect(parseGitHubLink("https://www.github.com/k2b-dev/cloud/pull/12/files?diff=split")).toEqual({
      owner: "k2b-dev",
      repo: "cloud",
      number: 12,
    });
    expect(parseGitHubLink("https://github.com/k2b-dev/cloud")).toBeNull();
    expect(parseGitHubLink("https://github.com/k2b-dev/cloud/issues")).toBeNull();
    expect(parseGitHubLink("https://github.com/k2b-dev/cloud/issues/0")).toBeNull();
    expect(parseGitHubLink("http://github.com/k2b-dev/cloud/issues/1")).toBeNull();
    expect(parseGitHubLink("https://gitlab.com/k2b-dev/cloud/-/issues/1")).toBeNull();
    expect(parseGitHubLink("https://github.com.evil.example/k2b-dev/cloud/issues/1")).toBeNull();
  });
});

describe("fetchGitHubPreview", () => {
  const target = { owner: "k2b-dev", repo: "cloud", number: 263 };

  test("maps an issue and sends the token only when present", async () => {
    const { fetchMock, calls } = githubFetch(200, { title: "Links on items", state: "open" });
    expect(await fetchGitHubPreview(target, { fetch: fetchMock })).toEqual({
      status: "ok",
      preview: { kind: "github", repo: "k2b-dev/cloud", number: 263, type: "issue", title: "Links on items", state: "open" },
    });
    expect(calls[0]?.url).toBe("https://api.github.com/repos/k2b-dev/cloud/issues/263");
    expect(calls[0]?.headers.authorization).toBeUndefined();
    await fetchGitHubPreview(target, { fetch: fetchMock, token: "ghp_test" });
    expect(calls[1]?.headers.authorization).toBe("Bearer ghp_test");
  });

  test("distinguishes merged, closed and open pull requests", async () => {
    const merged = githubFetch(200, { title: "PR", state: "closed", pull_request: { merged_at: "2026-09-01T00:00:00Z" } });
    expect(await fetchGitHubPreview(target, { fetch: merged.fetchMock })).toMatchObject({ preview: { type: "pull", state: "merged" } });
    const closed = githubFetch(200, { title: "PR", state: "closed", pull_request: { merged_at: null } });
    expect(await fetchGitHubPreview(target, { fetch: closed.fetchMock })).toMatchObject({ preview: { type: "pull", state: "closed" } });
    const open = githubFetch(200, { title: "PR", state: "open", pull_request: {} });
    expect(await fetchGitHubPreview(target, { fetch: open.fetchMock })).toMatchObject({ preview: { type: "pull", state: "open" } });
  });

  test("treats private or missing issues as missing and rate limits as limited", async () => {
    expect(await fetchGitHubPreview(target, { fetch: githubFetch(404, { message: "Not Found" }).fetchMock })).toEqual({
      status: "missing",
    });
    expect(await fetchGitHubPreview(target, { fetch: githubFetch(403, { message: "Forbidden" }).fetchMock })).toEqual({
      status: "missing",
    });
    expect(
      await fetchGitHubPreview(target, { fetch: githubFetch(403, { message: "rate" }, { "x-ratelimit-remaining": "0" }).fetchMock }),
    ).toEqual({ status: "limited" });
    expect(await fetchGitHubPreview(target, { fetch: githubFetch(429, "").fetchMock })).toEqual({ status: "limited" });
    expect(await fetchGitHubPreview(target, { fetch: githubFetch(500, "").fetchMock })).toEqual({ status: "error" });
  });

  test("rejects malformed or oversized bodies and network failures", async () => {
    expect(await fetchGitHubPreview(target, { fetch: githubFetch(200, "not json").fetchMock })).toEqual({ status: "error" });
    expect(await fetchGitHubPreview(target, { fetch: githubFetch(200, { state: "open" }).fetchMock })).toEqual({ status: "error" });
    const huge = githubFetch(200, JSON.stringify({ title: "x".repeat(300 * 1024), state: "open" }));
    expect(await fetchGitHubPreview(target, { fetch: huge.fetchMock })).toEqual({ status: "error" });
    const failing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await fetchGitHubPreview(target, { fetch: failing })).toEqual({ status: "error" });
  });
});

describe("resolveLinkPreviews", () => {
  const links = [{ url: "https://github.com/k2b-dev/cloud/issues/263" }, { url: "https://example.org/spec" }];

  test("SSR mode only reads the cache; fill mode fetches once and caches per Space", async () => {
    const { store, entries } = memoryStore();
    const { fetchMock, calls } = githubFetch(200, { title: "Links on items", state: "open" });
    const cached = await resolveLinkPreviews(links, { spaceId: "s1", mode: "cached", store, fetch: fetchMock, budget: openBudget });
    expect(cached.map((link) => link.preview)).toEqual([null, null]);
    expect(calls).toHaveLength(0);

    const filled = await resolveLinkPreviews(links, { spaceId: "s1", mode: "fill", store, fetch: fetchMock, budget: openBudget });
    expect(filled[0]?.preview).toMatchObject({ kind: "github", title: "Links on items", state: "open" });
    expect(filled[1]?.preview).toBeNull();
    expect(calls).toHaveLength(1);
    expect([...entries.keys()]).toEqual(["spaces:link-preview:v1:s1:k2b-dev/cloud#263"]);

    // The next SSR render is served from the cache, and another Space never shares it.
    const again = await resolveLinkPreviews(links, { spaceId: "s1", mode: "cached", store, fetch: fetchMock, budget: openBudget });
    expect(again[0]?.preview).toMatchObject({ title: "Links on items" });
    const other = await resolveLinkPreviews(links, { spaceId: "s2", mode: "cached", store, fetch: fetchMock, budget: openBudget });
    expect(other[0]?.preview).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test("caches a missing preview briefly and loads the Space token once", async () => {
    const { store, entries } = memoryStore();
    const { fetchMock, calls } = githubFetch(404, { message: "Not Found" });
    let tokenLoads = 0;
    const token = async () => {
      tokenLoads += 1;
      return "ghp_space";
    };
    const first = await resolveLinkPreviews([links[0]!, links[0]!], {
      spaceId: "s1",
      mode: "fill",
      store,
      fetch: fetchMock,
      token,
      budget: openBudget,
    });
    expect(first.map((link) => link.preview)).toEqual([null, null]);
    expect(tokenLoads).toBe(1);
    expect(calls.every((call) => call.headers.authorization === "Bearer ghp_space")).toBeTrue();
    expect(entries.get("spaces:link-preview:v1:s1:k2b-dev/cloud#263")).toEqual({ value: "!missing", ttl: 60 });
    await resolveLinkPreviews([links[0]!], { spaceId: "s1", mode: "fill", store, fetch: fetchMock, token, budget: openBudget });
    expect(calls).toHaveLength(2);
  });

  test("skips the fetch when the Space's budget is exhausted or the cache is down", async () => {
    const { fetchMock, calls } = githubFetch(200, { title: "x", state: "open" });
    const limited = { check: async () => ({ limited: true, remaining: 0, resetIn: 1000 }) };
    const { store } = memoryStore();
    const result = await resolveLinkPreviews([links[0]!], { spaceId: "s1", mode: "fill", store, fetch: fetchMock, budget: limited });
    expect(result[0]?.preview).toBeNull();
    expect(calls).toHaveLength(0);

    const broken: PreviewStore = {
      get: async () => {
        throw new Error("valkey down");
      },
      set: async () => {
        throw new Error("valkey down");
      },
    };
    const degraded = await resolveLinkPreviews([links[0]!], {
      spaceId: "s1",
      mode: "fill",
      store: broken,
      fetch: fetchMock,
      budget: openBudget,
    });
    expect(degraded[0]?.preview).toMatchObject({ title: "x" });
  });
});
