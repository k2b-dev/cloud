import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { resolveMailSearchRoute } from "../../search-state";
import { mailTestFolder } from "./mail-list-test-fixtures";

const root = mkdtempSync(join(tmpdir(), "mail-head-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { MailboxHeadFilters, MailboxTagFilter } = await import("./MailWorkspaceHead");
const tag = {
  id: "Tag001",
  mailboxId: "Box001",
  name: "Invoices",
  color: "#0f766e",
  revision: 1,
  createdAt: "2026-10-14T10:00:00Z",
  updatedAt: "2026-10-14T10:00:00Z",
};
const filters = (expression: object, localTags = [tag]) => {
  const requestUrl = `/app/mail/Box001?${new URLSearchParams({ search: JSON.stringify({ expression, sort: "newest" }) })}`;
  const props = {
    requestUrl,
    search: resolveMailSearchRoute(new URL(requestUrl, "https://cloud.test")),
    folders: [],
    folderId: null,
    localTags,
    onOpenHref: () => {},
    onEditSearch: () => {},
  };
  return renderToString(() => [createComponent(MailboxHeadFilters, props), createComponent(MailboxTagFilter, props)]);
};
test("head Tag icon names the selected tag, without displaying its ID or a second search chip", () => {
  const html = filters({ type: "local_tag_id", tagId: "Tag001" });
  expect(html).toContain('aria-label="Tag: Invoices"');
  expect(html).toContain('data-icon-only="true"');
  expect(html).toContain('data-active="true"');
  expect(html).toContain("Tag");
  expect(html).not.toContain("Tag001");
  expect(html).not.toContain("Search");
});
test("head Search chip summarizes structured conditions, including deleted tags inside a group", () => {
  expect(filters({ type: "text", field: "from", query: "billing@example.test", match: "exact" })).toContain("billing@example.test");
  const deleted = filters({
    type: "and",
    expressions: [
      { type: "local_tag_id", tagId: "Gone01" },
      { type: "work_status", value: "needs_action" },
    ],
  });
  expect(deleted).toContain("Search");
  expect(deleted).toContain("deleted tag");
  expect(deleted).not.toContain("Gone01");
});
test("a search for one deleted tag stays a Search chip that names it, because the Tag chip cannot", () => {
  for (const localTags of [[tag], []]) {
    const html = filters({ type: "local_tag_id", tagId: "Gone01" }, localTags);
    expect(html).toContain("Search");
    expect(html).toContain("deleted tag");
    expect(html).not.toContain("Gone01");
  }
});

test("folder quick filters render their actual placement scope and sent subset on the server", () => {
  for (const role of ["custom", "sent"]) {
    const requestUrl = "/app/mail/Box001?folder=Fold01";
    const html = renderToString(() =>
      createComponent(MailboxHeadFilters, {
        requestUrl,
        search: resolveMailSearchRoute(new URL(requestUrl, "https://cloud.test")),
        folderId: "Fold01",
        folders: [mailTestFolder("Fold01", { role, unread: 4 })],
        localTags: [tag],
        onOpenHref: () => {},
        onEditSearch: () => {},
      }),
    );
    expect(html).toContain("With attachment");
    expect(html).toContain("Date range");
    expect(html.includes("Unread")).toBe(role !== "sent");
    expect(html.includes("Flagged")).toBe(role !== "sent");
    expect(html).not.toContain("Fold01");
  }
});

test("a scoped tag names its folder and a Sent flag remains a visible advanced condition", () => {
  for (const flag of [false, true]) {
    const expression = {
      type: "and",
      expressions: [
        { type: "folder_id", folderId: "Sent01" },
        flag ? { type: "flagged", folderId: "Sent01" } : { type: "local_tag_id", tagId: "Tag001" },
      ],
    };
    const requestUrl = `/app/mail/Box001?${new URLSearchParams({ search: JSON.stringify({ expression, sort: "newest" }) })}`;
    const html = renderToString(() =>
      createComponent(MailboxHeadFilters, {
        requestUrl,
        search: resolveMailSearchRoute(new URL(requestUrl, "https://cloud.test")),
        folderId: null,
        folders: [mailTestFolder("Sent01", { role: "sent", name: "Sent" })],
        localTags: [tag],
        onOpenHref: () => {},
        onEditSearch: () => {},
      }),
    );
    expect(html).toContain(flag ? "Search" : "Only in Sent");
    if (flag) expect(html).toContain("Flagged");
    expect(html).not.toContain("Sent01");
  }
});

test("a direct search names its actual folder when the route selects a different one", () => {
  const expression = {
    type: "and",
    expressions: [
      { type: "folder_id", folderId: "Fold02" },
      { type: "unread", folderId: "Fold02" },
    ],
  };
  const requestUrl = `/app/mail/Box001?${new URLSearchParams({ folder: "Fold01", search: JSON.stringify({ expression, sort: "newest" }) })}`;
  const html = renderToString(() =>
    createComponent(MailboxHeadFilters, {
      requestUrl,
      search: resolveMailSearchRoute(new URL(requestUrl, "https://cloud.test")),
      folderId: "Fold01",
      folders: [mailTestFolder("Fold01", { name: "First" }), mailTestFolder("Fold02", { name: "Second" })],
      localTags: [],
      onOpenHref: () => {},
      onEditSearch: () => {},
    }),
  );
  expect(html).toContain("Only in Second");
  expect(html).not.toContain("Fold02");
});
