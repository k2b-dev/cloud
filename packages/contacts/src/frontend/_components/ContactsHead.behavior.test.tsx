import { expect, mock, test } from "bun:test";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { publishContactsHeadState, subscribeToContactsHeadChanges } from "./contacts-head-events";
import { workspaceFixture } from "./contacts-workspace.fixture";

const load = async () => {
  const dom = createDomTestHarness();
  try {
    return {
      Filters: (await import("./ContactsHeadFilters.island")).default,
      Tabs: (await import("./ContactsViewTabs.island")).default,
      Actions: (await import("./ContactsHeadActions.island")).default,
    };
  } finally {
    dom.cleanup();
  }
};
const components = isServer ? undefined : await load();

if (!components) test.skip("runs with Solid DOM conditions", () => {});
else {
  const { Filters, Tabs, Actions } = components;
  test("head follows results state, hides busy counts, resets while retaining the view/sort, and publishes tag changes", () => {
    const dom = createDomTestHarness();
    delegateEvents(["click", "input", "submit"], dom.document);
    const change = mock((_change: { href: string; resetSearch?: boolean }) => {});
    let state = {
      source: "/app/contacts?sort=updated&favorites=true",
      requestedSource: "/app/contacts?sort=updated&favorites=true",
      busy: false,
      total: 5,
      filtered: false,
      selectionMode: false,
    };
    const stop = subscribeToContactsHeadChanges(
      change,
      () => {},
      () => publishContactsHeadState(state),
    );
    const dispose = render(
      () => (
        <Filters
          initialHref={state.source}
          initialTotal={5}
          searchPlaceholder="Search"
          tags={workspaceFixture.tags}
          bookNames={workspaceFixture.bookNames}
        />
      ),
      dom.root,
    );
    try {
      expect(dom.root.querySelector(".contacts-head-count")).toBeNull();
      expect([...dom.root.querySelectorAll("a")].find((a) => a.textContent === "Reset")).toBeUndefined();
      const href = "/app/contacts?sort=updated&favorites=true&search=Ada&tag_id=vip&email=yes";
      state = { ...state, source: href, requestedSource: href, filtered: true, total: 1 };
      publishContactsHeadState(state);
      expect(dom.root.querySelector(".contacts-head-count")?.textContent).toBe("1 result");
      publishContactsHeadState({ ...state, busy: true });
      expect(dom.root.querySelector(".contacts-head-count")).toBeNull();
      publishContactsHeadState(state);
      const reset = [...dom.root.querySelectorAll("a")].find((a) => a.textContent === "Reset")!;
      expect(reset.getAttribute("href")).toBe("/app/contacts?sort=updated&favorites=true");
      reset.click();
      expect(change).toHaveBeenLastCalledWith({ href: "/app/contacts?sort=updated&favorites=true", resetSearch: true });
      publishContactsHeadState({ ...state, source: "/app/contacts", requestedSource: "/app/contacts", total: 5, filtered: false });
      dom.root.querySelector<HTMLAnchorElement>(".contacts-tag-chip a")!.click();
      expect(change).toHaveBeenLastCalledWith({ href: "/app/contacts?tag_id=vip", resetSearch: false });
    } finally {
      dispose();
      stop();
      dom.cleanup();
    }
  });

  test.each([
    ["Sort", "Recently updated", "sort", "updated"],
    ["Contact info", "Has email", "email", "yes"],
  ])("%s keeps a blurred search that has not debounced", (label, option, key, value) => {
    const dom = createDomTestHarness();
    delegateEvents(["click", "input", "focusin", "focusout"], dom.document);
    const state = {
      source: "/app/contacts?search=Grace",
      requestedSource: "/app/contacts?search=Grace",
      busy: false,
      total: 1,
      filtered: true,
      selectionMode: false,
    };
    const change = mock((_change: { href: string; resetSearch?: boolean }) => {});
    const stop = subscribeToContactsHeadChanges(
      change,
      () => {},
      () => publishContactsHeadState(state),
    );
    const dispose = render(
      () => <Filters initialHref={state.source} initialTotal={1} searchPlaceholder="Search" tags={[]} bookNames={{}} />,
      dom.root,
    );
    try {
      const input = dom.root.querySelector<HTMLInputElement>('input[type="search"]')!;
      input.focus();
      input.value = "Ada";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.blur();
      expect(change).not.toHaveBeenCalled();
      dom.root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click();
      const choice = [...dom.document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) =>
        item.textContent?.includes(option),
      );
      expect(choice).toBeDefined();
      choice!.click();
      expect(change).toHaveBeenCalledTimes(1);
      const url = new URL(change.mock.calls[0]![0].href, "http://localhost");
      expect(url.searchParams.get("search")).toBe("Ada");
      expect(url.searchParams.get(key)).toBe(value);
    } finally {
      dispose();
      stop();
      dom.cleanup();
    }
  });

  test.each(["search=Ada", "tag_id=vip", "email=yes", "phone=yes"])(
    "filtered Favorites adjusts its count independently of results (%s)",
    (filter) => {
      const dom = createDomTestHarness();
      const href = `/app/contacts/team?favorites=true&${filter}`;
      const dispose = render(() => <Tabs initialHref={href} bookId="team" allCount={8} favoritesCount={2} />, dom.root);
      const state = { source: href, requestedSource: href, busy: false, total: 1, filtered: true, selectionMode: false };
      const count = () => dom.root.querySelectorAll("a")[1]!.textContent;
      const favorite = (value: boolean) =>
        window.dispatchEvent(
          new CustomEvent("contacts:favorite-changed", {
            detail: { bookId: "team", contactId: "ada", favorite: value },
          }),
        );
      try {
        publishContactsHeadState(state);
        expect(count()).toContain("2");
        favorite(false);
        expect(count()).toContain("1");
        publishContactsHeadState({ ...state, total: 0 });
        expect(count()).toContain("1");
        favorite(false);
        favorite(false);
        expect(count()).toContain("0");
        favorite(true);
        expect(count()).toContain("1");
        // The bridge decides whether its total is filtered, even before the new source commits.
        publishContactsHeadState({ ...state, source: "/app/contacts/team?favorites=true", busy: true });
        favorite(true);
        expect(count()).toContain("2");
        publishContactsHeadState({ ...state, source: "/app/contacts/team?favorites=true", filtered: false, total: 4 });
        expect(count()).toContain("4");
        favorite(false);
        expect(count()).toContain("4");
        publishContactsHeadState({ ...state, source: "/app/contacts/team?favorites=true", filtered: false, total: 3 });
        expect(count()).toContain("3");
      } finally {
        dispose();
        dom.cleanup();
      }
    },
  );

  test("tabs follow committed filters and current unfiltered totals; favorites changes stay in scope", () => {
    const dom = createDomTestHarness();
    const dispose = render(() => <Tabs initialHref="/app/contacts/team" bookId="team" allCount={8} favoritesCount={2} />, dom.root);
    const favorite = (bookId: string, value: boolean) =>
      window.dispatchEvent(new CustomEvent("contacts:favorite-changed", { detail: { bookId, contactId: "ada", favorite: value } }));
    const tabs = () => [...dom.root.querySelectorAll("a")];
    try {
      publishContactsHeadState({
        source: "/app/contacts/team?tag_id=vip",
        requestedSource: "/app/contacts/team?tag_id=vip",
        busy: false,
        total: 1,
        filtered: true,
        selectionMode: false,
      });
      expect(tabs()[1]!.getAttribute("href")).toBe("/app/contacts/team?tag_id=vip&favorites=true");
      expect(tabs()[0]!.textContent).toContain("8");
      favorite("other", true);
      expect(tabs()[1]!.textContent).toContain("2");
      favorite("team", true);
      expect(tabs()[1]!.textContent).toContain("3");
      for (let i = 0; i < 5; i++) favorite("team", false);
      expect(tabs()[1]!.textContent).toContain("0");
      publishContactsHeadState({
        source: "/app/contacts/team?favorites=true",
        requestedSource: "/app/contacts/team?favorites=true",
        busy: false,
        total: 4,
        filtered: false,
        selectionMode: false,
      });
      expect(tabs()[1]!.textContent).toContain("4");
      favorite("team", false);
      expect(tabs()[1]!.textContent).toContain("4");
      tabs()[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      expect(dom.document.cookie).toContain("contacts.favorites-tab");
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("Select sends a bridge toggle and updates to Stop selecting when results answers", () => {
    const dom = createDomTestHarness();
    const toggle = mock(() => {});
    const stop = subscribeToContactsHeadChanges(
      () => {},
      toggle,
      () =>
        publishContactsHeadState({
          source: "/app/contacts/team",
          requestedSource: "/app/contacts/team",
          busy: false,
          total: 0,
          filtered: false,
          selectionMode: false,
        }),
    );
    const dispose = render(() => <Actions bookId="team" canWrite canManage={false} initialHref="/app/contacts/team" />, dom.root);
    delegateEvents(["click"], dom.document);
    try {
      const select = [...dom.root.querySelectorAll("button")].find((button) => button.textContent === "Select")!;
      expect(select).toBeDefined();
      select.click();
      expect(toggle).toHaveBeenCalledTimes(1);
      publishContactsHeadState({
        source: "/app/contacts/team",
        requestedSource: "/app/contacts/team",
        busy: false,
        total: 0,
        filtered: false,
        selectionMode: true,
      });
      expect(dom.root.textContent).toContain("Stop selecting");
    } finally {
      dispose();
      stop();
      dom.cleanup();
    }
  });
}
