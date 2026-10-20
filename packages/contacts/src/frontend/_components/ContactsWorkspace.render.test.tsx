import { expect, spyOn, test } from "bun:test";
import { renderToString } from "solid-js/web";
import "./ssr-test-plugin";
import { workspaceFixture } from "./contacts-workspace.fixture";

const { default: ContactsWorkspace } = await import("./ContactsWorkspace");
const { default: ContactsHeadFilters } = await import("./ContactsHeadFilters.island");
const { LocaleProvider } = await import("@k2b/ui");

import { createDomTestHarness } from "../../../../ui/test/dom";

const parse = (html: string) => {
  const dom = createDomTestHarness();
  dom.root.innerHTML = html;
  return { document: dom.document, close: dom.cleanup };
};

for (const bookId of [undefined, "team"]) {
  test(`favorites is a current tab inside ${bookId ?? "all books"}; links retain filters and drop selection/page`, () => {
    const path = `/app/contacts${bookId ? `/${bookId}` : ""}`;
    const authoringErrors = spyOn(console, "error").mockImplementation(() => {});
    const html = renderToString(() => (
      <LocaleProvider locale="de">
        <ContactsWorkspace
          {...workspaceFixture}
          bookId={bookId}
          resultHref={`${path}?favorites=true&search=Ada&tag_id=vip&sort=updated&email=yes&phone=no&page=3&contact=ada&contactBook=team`}
        />
      </LocaleProvider>
    ));
    try {
      expect(authoringErrors.mock.calls).toEqual([]);
    } finally {
      authoringErrors.mockRestore();
    }
    const window = parse(html);
    try {
      const doc = window.document;
      const tabs = doc.querySelector(".contacts-view-tabs")!;
      expect(tabs.querySelector('[aria-current="page"]')?.textContent).toContain("Favoriten");
      for (const tab of tabs.querySelectorAll("a")) {
        const url = new URL(tab.getAttribute("href")!, "http://localhost");
        expect(url.pathname).toBe(path);
        expect([...url.searchParams.keys()]).not.toContain("page");
        expect([...url.searchParams.keys()]).not.toContain("contact");
        expect([...url.searchParams.keys()]).not.toContain("contactBook");
        for (const [key, value] of Object.entries({ search: "Ada", tag_id: "vip", sort: "updated", email: "yes", phone: "no" }))
          expect(url.searchParams.get(key)).toBe(value);
      }
      const main = doc.querySelector("[data-workspace-main]") ?? doc.querySelector(".k2b-app-workspace__main");
      expect(main).not.toBeNull();
      expect(main!.querySelector("h1")).toBeNull();
      expect(main!.textContent).not.toContain("Book description only in settings");
      expect(main!.querySelector('[aria-live="polite"]')?.classList.contains("sr-only")).toBe(true);
      expect(main!.querySelector('[role="search"]')).toBeNull();
      expect(html).toContain('data-mobile="stacked"');
      expect(doc.querySelector('[data-workspace-collapsible="true"]')).not.toBeNull();
      const sidebar = doc.querySelector(".k2b-app-workspace__sidebar");
      expect(sidebar?.textContent).not.toContain("Favoriten");
      const nav = JSON.parse(doc.querySelector("script[data-cloud-workspace-navigation]")!.textContent!);
      expect(nav.items.some((item: { id: string }) => item.id === "favorites")).toBe(false);
      if (!bookId) {
        expect(nav.items.find((item: { id: string }) => item.id === "all").active).toBe(true);
        expect(sidebar?.querySelector('a[href="/app/contacts"]')?.getAttribute("aria-current")).toBe("page");
      }
      expect(doc.querySelector('[data-workspace-detail-phone="page"][data-width="lg"]')).not.toBeNull();
    } finally {
      window.close();
    }
  });
}

test("tag chips name every tag next to a dot, with book context and no colored Tag label", () => {
  const html = renderToString(() => (
    <ContactsHeadFilters
      initialHref="/app/contacts?tag_id=vip"
      initialTotal={1}
      searchPlaceholder="Search"
      tags={workspaceFixture.tags}
      bookNames={workspaceFixture.bookNames}
      showBookNames
    />
  ));
  const window = parse(html);
  try {
    const chips = window.document.querySelectorAll(".contacts-tag-chip");
    expect(chips.length).toBe(2);
    for (const [index, chip] of [...chips].entries()) {
      const tag = workspaceFixture.tags[index]!;
      expect(chip.textContent).toBe(tag.name);
      expect(chip.querySelector("i.contacts-tag-dot")).not.toBeNull();
      expect(chip.getAttribute("style")).toContain(`--app-contacts-tag-color:${tag.color}`);
      expect(chip.querySelector("a")?.title).toBe(`${tag.name} · Team`);
      expect(chip.querySelector(".k2b-tag")).toBeNull();
    }
    expect(chips[0]!.querySelector("a")?.getAttribute("aria-current")).toBe("true");
  } finally {
    window.close();
  }
});

for (const query of ["", "?sort=updated", "?favorites=true", "?search=Ada", "?tag_id=vip", "?email=yes", "?phone=no"]) {
  test(`quiet count and reset follow filters: ${query || "none"}`, () => {
    const filtered = /search|tag_id|email|phone/.test(query);
    const html = renderToString(() => (
      <ContactsHeadFilters initialHref={`/app/contacts${query}`} initialTotal={1} searchPlaceholder="Search" tags={[]} bookNames={{}} />
    ));
    expect(html.includes('class="contacts-head-count"')).toBe(filtered);
    expect(html.includes("contacts-head-reset")).toBe(filtered);
    if (filtered) expect(html).toContain("1 result");
  });
}

for (const [bookId, write, admin] of [
  [undefined, true, true],
  ["team", false, false],
  ["team", true, false],
  ["team", true, true],
] as const) {
  test(`book actions visibility: ${bookId} write=${write} admin=${admin}`, () => {
    const html = renderToString(() => (
      <ContactsWorkspace
        {...workspaceFixture}
        bookId={bookId}
        writableBooks={write ? [{ id: "team", name: "Team" }] : []}
        adminBookIds={admin ? ["team"] : []}
      />
    ));
    const window = parse(html);
    try {
      const actions = window.document.querySelector(".contacts-head-actions");
      expect(Boolean(actions)).toBe(Boolean(bookId && (write || admin)));
      if (actions) {
        expect(actions.textContent).toContain("Duplicates");
        expect(actions.textContent).toContain("Select");
        expect(actions.textContent?.includes("Book settings")).toBe(admin);
      }
    } finally {
      window.close();
    }
  });
}
