import { describe, expect, test } from "bun:test";
import { createContactsResultsNavigation } from "./contacts-results-navigation";

const setup = () => {
  let source = "/app/contacts?search=Ada";
  const order: string[] = [];
  const navigation = createContactsResultsNavigation({
    initialSource: source,
    initialHref: source,
    setSource: (next) => {
      source = next;
      order.push(`source:${next}`);
    },
  });
  const start = (href: string) =>
    navigation.navigate(href, {
      onApply: (appliedHref) => order.push(`history:${appliedHref}`),
      onFallback: (fallbackHref) => order.push(`fallback:${fallbackHref}`),
    });
  const apply = (requestedHref: string, canonicalHref = requestedHref) =>
    navigation.apply(requestedHref, canonicalHref, () => order.push(`apply:${canonicalHref}`));
  return { navigation, source: () => source, order, start, apply };
};

describe("Contacts results navigation", () => {
  test("supersedes an older request and commits history only after the winning result applies", async () => {
    const state = setup();
    const first = state.start("/app/contacts?search=Grace");
    const second = state.start("/app/contacts?search=Linus");

    expect(await first).toEqual({ kind: "superseded" });
    expect(state.apply("/app/contacts?search=Grace")).toBe(false);
    expect(state.order.filter((entry) => entry.startsWith("history:"))).toEqual([]);
    expect(state.apply("/app/contacts?search=Linus")).toBe(true);
    expect(await second).toEqual({ kind: "applied", href: "/app/contacts?search=Linus" });
    expect(state.order.slice(-2)).toEqual(["apply:/app/contacts?search=Linus", "history:/app/contacts?search=Linus"]);
  });

  test("rolls a failed request back before running its document fallback", async () => {
    const state = setup();
    const pending = state.start("/app/contacts?search=Grace");

    expect(state.navigation.fail("/app/contacts?search=Grace")).toBe(true);
    expect(await pending).toEqual({ kind: "fallback", href: "/app/contacts?search=Grace" });
    expect(state.source()).toBe("/app/contacts?search=Ada");
    expect(state.order.slice(-2)).toEqual(["source:/app/contacts?search=Ada", "fallback:/app/contacts?search=Grace"]);
  });

  test("rebases a clamped page so later invalidation keeps loading the canonical page", async () => {
    const state = setup();
    const requested = "/app/contacts?search=Ada&page=9";
    const pending = state.start(requested);

    expect(state.apply(requested, "/app/contacts?search=Ada&page=3")).toBe(true);
    expect(await pending).toEqual({ kind: "applied", href: "/app/contacts?search=Ada&page=3" });
    expect(state.navigation.committedSource()).toBe("/app/contacts?search=Ada&page=3");
    expect(state.navigation.committedHref()).toBe("/app/contacts?search=Ada&page=3");
    expect(state.source()).toBe("/app/contacts?search=Ada&page=3");

    // The result set can grow again before a live invalidation. The query still
    // reads its canonical source instead of retrying the rejected page 9.
    expect(state.source()).toBe(state.navigation.committedSource());
  });

  test("draft changes supersede pending navigation without creating a fallback", async () => {
    const state = setup();
    const pending = state.start("/app/contacts?search=Grace");

    state.navigation.supersede();

    expect(await pending).toEqual({ kind: "superseded" });
    expect(state.source()).toBe("/app/contacts?search=Ada");
    expect(state.navigation.fail("/app/contacts?search=Grace")).toBe(false);
    expect(state.order.some((entry) => entry.startsWith("fallback:"))).toBe(false);
  });

  test("returns to the committed target while a different target is pending", async () => {
    const state = setup();
    const pending = state.start("/app/contacts?search=Grace");

    const returned = state.start("/app/contacts?search=Ada");

    expect(await pending).toEqual({ kind: "superseded" });
    expect(await returned).toEqual({ kind: "applied", href: "/app/contacts?search=Ada" });
    expect(state.source()).toBe("/app/contacts?search=Ada");
  });

  test("lets only the latest repeated target request observe the apply", async () => {
    const state = setup();
    const first = state.start("/app/contacts?search=Grace");
    const second = state.start("/app/contacts?search=Grace");

    expect(await first).toEqual({ kind: "superseded" });
    expect(state.apply("/app/contacts?search=Grace")).toBe(true);
    expect(await second).toEqual({ kind: "applied", href: "/app/contacts?search=Grace" });
    expect(state.order.filter((entry) => entry.startsWith("history:"))).toEqual(["history:/app/contacts?search=Grace"]);
  });

  test("treats only the rebased canonical href as the current target", async () => {
    const state = setup();
    const requested = "/app/contacts?search=Ada&page=9";
    const pending = state.start(requested);
    state.apply(requested, "/app/contacts?search=Ada&page=3");
    await pending;

    expect(await state.navigation.navigate("/app/contacts?search=Ada&page=3")).toEqual({
      kind: "applied",
      href: "/app/contacts?search=Ada&page=3",
    });
  });

  test("can hide committed data during popstate and applies without writing history", async () => {
    const state = setup();
    const pending = state.navigation.navigate("/app/contacts?search=Grace", { retainCommitted: false });

    expect(state.navigation.canRenderCommitted()).toBe(false);
    expect(state.apply("/app/contacts?search=Grace")).toBe(true);
    expect(await pending).toEqual({ kind: "applied", href: "/app/contacts?search=Grace" });
    expect(state.order.filter((entry) => entry.startsWith("history:"))).toEqual([]);
  });

  test("dispose resolves pending callers without applying late state", async () => {
    const state = setup();
    const pending = state.start("/app/contacts?search=Grace");

    state.navigation.dispose();

    expect(await pending).toEqual({ kind: "superseded" });
    expect(state.apply("/app/contacts?search=Grace")).toBe(false);
  });
});
