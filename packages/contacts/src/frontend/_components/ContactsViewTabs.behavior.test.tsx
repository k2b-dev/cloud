import { expect, mock, spyOn, test } from "bun:test";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { publishContactsHeadState } from "./contacts-head-events";

const load = async () => {
  const dom = createDomTestHarness();
  try {
    return (await import("./ContactsViewTabs.island")).default;
  } finally {
    dom.cleanup();
  }
};
const Tabs = isServer ? undefined : await load();

const favorite = (bookId = "team") =>
  window.dispatchEvent(new CustomEvent("contacts:favorite-changed", { detail: { bookId, contactId: "ada", favorite: false } }));
const live = (type = "contacts.changed", covered = type === "contacts.changed") => {
  const cover = mock((_owner: string, work: Promise<void>) => void work.catch(() => {}));
  window.dispatchEvent(
    new CustomEvent("contacts:live-invalidation", {
      detail: { invalidation: { type, bookId: "team", at: "2026-10-20T12:00:00.000Z" }, cover },
    }),
  );
  if (covered) {
    expect(cover).toHaveBeenCalledTimes(1);
    expect(cover.mock.calls[0]![0]).toBe("results");
    return cover.mock.calls[0]![1];
  }
  expect(cover).not.toHaveBeenCalled();
};
// Drain fetch, JSON parsing and Solid updates without advancing debounce timers.
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

if (!Tabs) test.skip("runs with Solid DOM conditions", () => {});
else {
  const setup = (bookId?: string) => {
    const dom = createDomTestHarness();
    const requests: Array<{
      url: URL;
      signal: AbortSignal | undefined | null;
      response: ReturnType<typeof Promise.withResolvers<Response>>;
    }> = [];
    const originalFetch = globalThis.fetch;
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
          const response = Promise.withResolvers<Response>();
          requests.push({ url: new URL(String(input), window.location.origin), signal: init?.signal, response });
          return response.promise;
        },
        { preconnect: originalFetch.preconnect },
      ),
    );
    const href = `/app/contacts${bookId ? `/${bookId}` : ""}?favorites=true&search=Ada&tag_id=vip&email=yes&phone=no&sort=updated&page=3`;
    const dispose = render(() => <Tabs initialHref={href} bookId={bookId} allCount={8} favoritesCount={2} />, dom.root);
    delegateEvents(["click"], dom.document);
    const counts = () => [...dom.root.querySelectorAll(".k2b-view-tabs__count")].map((count) => count.textContent);
    const retry = () => dom.root.querySelector<HTMLButtonElement>(".contacts-count-retry")!;
    const respond = (offset: number, all: number, favorites: number) => {
      for (const [index, total] of [all, favorites].entries())
        requests[offset + index]!.response.resolve(Response.json({ pagination: { total } }));
    };
    return {
      requests,
      counts,
      retry,
      respond,
      dispose,
      href,
      cleanup: () => {
        dispose();
        fetch.mockRestore();
        dom.cleanup();
      },
    };
  };

  for (const bookId of ["team", undefined]) {
    for (const event of ["favorite", "live"]) {
      test(`${event} refreshes both unfiltered counts for ${bookId ?? "all books"}`, async () => {
        const state = setup(bookId);
        try {
          expect(state.counts()).toEqual(["8", "2"]);
          expect(state.requests).toHaveLength(0);
          if (event === "favorite") favorite();
          else live();
          await settle();
          expect(state.requests).toHaveLength(2);
          for (const [index, request] of state.requests.entries()) {
            expect(request.url.pathname).toBe(bookId ? `/api/contacts/books/${bookId}/contacts` : "/api/contacts/search");
            expect(Object.fromEntries(request.url.searchParams)).toEqual({
              page: "1",
              per_page: "1",
              ...(index === 1 ? { favorites: "true" } : {}),
            });
          }
          state.respond(0, 11, 4);
          await settle();
          expect(state.counts()).toEqual(["11", "4"]);
          expect(state.requests).toHaveLength(2);
          publishContactsHeadState({
            source: state.href,
            requestedSource: state.href,
            total: 99,
            filtered: false,
            busy: false,
            selectionMode: false,
          });
          expect(state.counts()).toEqual(["11", "4"]);
          expect(state.requests).toHaveLength(2);
        } finally {
          state.cleanup();
        }
      });
    }
  }

  test("a burst during a refresh produces exactly one follow-up for both counts", async () => {
    const state = setup("team");
    try {
      favorite();
      await settle();
      favorite();
      live();
      await settle();
      live();
      expect(state.requests).toHaveLength(2);
      state.respond(0, 10, 3);
      await settle();
      expect(state.requests).toHaveLength(4);
      state.respond(2, 12, 5);
      await settle();
      expect(state.counts()).toEqual(["12", "5"]);
      expect(state.requests).toHaveLength(4);
    } finally {
      state.cleanup();
    }
  });

  test("unrelated favorites and non-results live events do not refresh counts", () => {
    const state = setup("team");
    try {
      favorite("other");
      live("notes.changed");
      live("tags.changed");
      expect(state.requests).toHaveLength(0);
    } finally {
      state.cleanup();
    }
  });

  test("a failed refresh keeps both last counts, waits for both reads, and offers Retry without another event", async () => {
    const state = setup();
    try {
      favorite();
      await settle();
      state.respond(0, 11, 4);
      await settle();
      favorite();
      await settle();
      state.requests[2]!.response.resolve(Response.json({}, { status: 500 }));
      await settle();
      expect(state.requests).toHaveLength(4);
      expect(state.counts()).toEqual(["11", "4"]);
      state.requests[3]!.response.resolve(Response.json({ pagination: { total: 9 } }));
      await settle();
      expect(state.counts()).toEqual(["11", "4"]);
      expect(state.retry().style.visibility).toBe("visible");
      expect(state.retry().getAttribute("aria-label")).toContain("Retry");
      state.retry().click();
      await settle();
      expect(state.requests).toHaveLength(6);
      state.respond(4, 15, 6);
      await settle();
      expect(state.counts()).toEqual(["15", "6"]);
      expect(state.retry().style.visibility).toBe("hidden");
    } finally {
      state.cleanup();
    }
  });

  test("live coverage waits for both count reads and rejects a failed update", async () => {
    const state = setup("team");
    try {
      const applied = live()!;
      const result = mock((_result: string) => {});
      void applied.then(
        () => result("applied"),
        () => result("failed"),
      );
      await settle();
      state.requests[0]!.response.resolve(Response.json({ pagination: { total: 10 } }));
      await settle();
      expect(result).not.toHaveBeenCalled();
      state.requests[1]!.response.resolve(Response.json({}, { status: 500 }));
      await settle();
      expect(result).toHaveBeenCalledWith("failed");
      expect(state.counts()).toEqual(["8", "2"]);
      const recovered = live()!;
      await settle();
      state.respond(2, 12, 5);
      await recovered;
      expect(state.counts()).toEqual(["12", "5"]);
    } finally {
      state.cleanup();
    }
  });

  test("cleanup aborts both reads, removes listeners, and discards a queued refresh", async () => {
    const state = setup("team");
    try {
      favorite();
      await settle();
      live();
      state.dispose();
      expect(state.requests).toHaveLength(2);
      expect(state.requests.every((request) => request.signal?.aborted)).toBe(true);
      state.respond(0, 11, 4);
      await settle();
      favorite();
      live("contacts.changed", false);
      expect(state.requests).toHaveLength(2);
    } finally {
      state.cleanup();
    }
  });
}
