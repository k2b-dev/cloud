import { describe, expect, test } from "bun:test";
import { networkTransportFixture } from "../../../../scripts/fixtures/network-transport";
import { __test, mailingListMetadata, subscriptionLink } from "./list-subscriptions";
import { EMPTY_MESSAGE_PROTOCOL_FACTS } from "./message-protocol";

const publicLookup = async () => [{ address: "1.1.1.1", family: 4 as const }];

describe("mailing-list subscription metadata", () => {
  test("derives one canonical list context for API and inspector views", () => {
    expect(
      mailingListMetadata({
        ...EMPTY_MESSAGE_PROTOCOL_FACTS,
        list: {
          id: "Project Updates <Updates.Example.test>",
          unsubscribe: ["https://lists.example.test/unsubscribe"],
          unsubscribePost: "List-Unsubscribe=One-Click",
          post: ["mailto:updates@example.test"],
          help: ["https://lists.example.test/help"],
          archive: ["https://lists.example.test/archive"],
        },
      }),
    ).toEqual({
      listKey: "updates.example.test",
      name: "Project Updates",
      address: "updates.example.test",
      unsubscribe: { kind: "one_click", href: "https://lists.example.test/unsubscribe" },
      postHref: "mailto:updates@example.test",
      helpHref: "https://lists.example.test/help",
      archiveHref: "https://lists.example.test/archive",
    });
  });

  test("normalizes named and bare List-ID values", () => {
    expect(__test.normalizeListId("Example updates <News.Example.test>")).toEqual({
      key: "news.example.test",
      name: "Example updates",
      address: "news.example.test",
    });
    expect(__test.normalizeListId("News.Example.test")).toEqual({
      key: "news.example.test",
      name: "News.Example.test",
      address: "news.example.test",
    });
  });

  test("selects one-click only when RFC 8058 is advertised", () => {
    expect(subscriptionLink(["mailto:leave@example.test", "https://example.test/unsubscribe"], "List-Unsubscribe=One-Click")).toEqual({
      kind: "one_click",
      href: "https://example.test/unsubscribe",
    });
    expect(subscriptionLink(["https://example.test/unsubscribe"], null)).toEqual({
      kind: "web",
      href: "https://example.test/unsubscribe",
    });
    expect(subscriptionLink(["mailto:leave@example.test"], null)).toEqual({
      kind: "email",
      href: "mailto:leave@example.test",
    });
  });

  test("rejects executable and credential-bearing links", () => {
    expect(__test.allowedExternalHref("javascript:alert(1)")).toBeNull();
    expect(__test.allowedExternalHref("https://user:secret@example.test/unsubscribe")).toBeNull();
    expect(subscriptionLink(["javascript:alert(1)"], "List-Unsubscribe=One-Click")).toBeNull();
  });
});

describe("one-click unsubscribe transport", () => {
  test("rejects private DNS targets before sending", async () => {
    let sent = false;
    await expect(
      __test.postOneClick("https://example.test/unsubscribe", {
        lookup: async () => [{ address: "127.0.0.1", family: 4 }],
        request: async () => {
          sent = true;
          return { statusCode: 204, location: null };
        },
      }),
    ).rejects.toThrow("private or reserved");
    expect(sent).toBe(false);
  });

  test("follows bounded 307 redirects and revalidates every target", async () => {
    const requests: string[] = [];
    await __test.postOneClick("https://example.test/unsubscribe", {
      lookup: publicLookup,
      request: async (url) => {
        requests.push(url.toString());
        return requests.length === 1
          ? { statusCode: 307, location: "https://redirect.example.test/confirm" }
          : { statusCode: 204, location: null };
      },
    });
    expect(requests).toEqual(["https://example.test/unsubscribe", "https://redirect.example.test/confirm"]);
  });

  test("rejects redirects that can change POST semantics", async () => {
    await expect(
      __test.postOneClick("https://example.test/unsubscribe", {
        lookup: publicLookup,
        request: async () => ({ statusCode: 302, location: "https://example.test/complete" }),
      }),
    ).rejects.toThrow("unsafe redirect");
  });
});

for (const mode of ["deadline", "caller"] as const)
  test(`unsubscribe ${mode} bounds DNS and ignores a late answer`, async () => {
    const lookup = Promise.withResolvers<Array<{ address: string; family: 4 }>>();
    const caller = new AbortController();
    let requests = 0;
    const pending = __test.postOneClick("https://lists.example/unsubscribe", {
      timeoutMs: mode === "deadline" ? 10 : 10_000,
      signal: caller.signal,
      lookup: () => lookup.promise,
      request: async () => {
        requests++;
        return { statusCode: 204, location: null };
      },
    });
    if (mode === "caller") caller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow(mode === "deadline" ? "timed out" : "cancelled");
    lookup.resolve([{ address: "1.1.1.1", family: 4 }]);
    await Bun.sleep(0);
    expect(requests).toBe(0);
  });

for (const mode of ["deadline", "caller"] as const)
  test(`unsubscribe ${mode} closes a slow endless successful body`, async () => {
    const fixture = await networkTransportFixture((_req, res) => {
      res.write("x");
      const timer = setInterval(() => res.write("x"), 5);
      res.once("close", () => clearInterval(timer));
    });
    const caller = new AbortController();
    try {
      const pending = __test.postOneClick("https://lists.example/unsubscribe", {
        timeoutMs: mode === "deadline" ? 80 : 10_000,
        signal: caller.signal,
        lookup: publicLookup,
        httpsRequest: fixture.request,
      });
      await fixture.firstResponse;
      if (mode === "caller") caller.abort(new Error("cancelled"));
      await expect(pending).rejects.toThrow(mode === "deadline" ? "timed out" : "cancelled");
      expect(fixture.requests[0]!.destroyed).toBe(true);
      await fixture.disconnected();
      expect(fixture.responses[0]!.destroyed).toBe(true);
    } finally {
      await fixture.close();
    }
  });

test("unsubscribe closes an endless redirect body before following with POST", async () => {
  const fixture = await networkTransportFixture((req, res) => {
    expect(req.method).toBe("POST");
    if (req.url === "/start") {
      res.writeHead(307, { location: "/done" });
      res.write("unused");
    } else res.writeHead(204).end();
  });
  try {
    await __test.postOneClick("https://lists.example/start", { lookup: publicLookup, httpsRequest: fixture.request });
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests.every((request) => request.destroyed)).toBe(true);
    await fixture.disconnected();
    expect(fixture.responses.every((response) => response.destroyed)).toBe(true);
  } finally {
    await fixture.close();
  }
});

test("unsubscribe redirects share one signal and pass only the remaining budget", async () => {
  const signals: AbortSignal[] = [];
  const budgets: number[] = [];
  await __test.postOneClick("https://lists.example/start", {
    timeoutMs: 1000,
    lookup: publicLookup,
    request: async (_url, _addresses, budget, signal) => {
      signals.push(signal);
      budgets.push(budget);
      if (signals.length === 1) {
        await Bun.sleep(10);
        return { statusCode: 308, location: "/done" };
      }
      return { statusCode: 204, location: null };
    },
  });
  expect(signals[0]).toBe(signals[1]);
  expect(budgets[1]!).toBeLessThan(budgets[0]!);
});

for (const [href, hostname, port] of [
  ["https://lists.example:8443/unsubscribe?q=1", "lists.example", 8443],
  ["https://[2606:4700:4700::1111]:8443/unsubscribe?q=1", "2606:4700:4700::1111", 8443],
] as const)
  test(`unsubscribe preserves URL routing and pinning for ${hostname}`, async () => {
    const stop = new Error("stopped before I/O");
    await expect(
      __test.postOneClick(href, {
        lookup: publicLookup,
        httpsRequest: (options) => {
          expect(options).toMatchObject({ hostname, port, path: "/unsubscribe?q=1", method: "POST", agent: false });
          expect(options.lookup).toBeFunction();
          throw stop;
        },
      }),
    ).rejects.toBe(stop);
  });
