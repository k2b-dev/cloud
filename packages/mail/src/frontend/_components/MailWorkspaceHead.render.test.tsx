import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { resolveMailSearchRoute } from "../../search-state";
import { DEFAULT_MAIL_QUICK_SEARCH_FIELDS } from "../../search-url";
import type { MailFolderView } from "../../service/messages";
import { mailTestFolder } from "./mail-list-test-fixtures";

const root = mkdtempSync(join(tmpdir(), "mail-head-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { MailSearchFilter } = await import("./MailWorkspaceHead");
const tag = {
  id: "Tag001",
  mailboxId: "Box001",
  name: "Invoices",
  color: "#0f766e",
  revision: 1,
  createdAt: "2026-10-14T10:00:00Z",
  updatedAt: "2026-10-14T10:00:00Z",
};
/** A quiet mailbox search: no text, the default fields, the whole mailbox. */
const quickSearch = (summary: string | null = null) => ({
  searchValue: () => "",
  searchFields: () => [...DEFAULT_MAIL_QUICK_SEARCH_FIELDS],
  quickSearchFieldOptions: () => [],
  updateSearchFields: () => {},
  scopeFolderId: () => null,
  originFolder: () => null,
  updateScope: () => {},
  structuredSummary: () => summary,
  openAdvancedSearch: async () => {},
  searchBuilderLoading: () => false,
});
const render = (input: {
  requestUrl: string;
  folderId?: string | null;
  folders?: MailFolderView[];
  localTags?: (typeof tag)[];
  summary?: string;
}) =>
  renderToString(() =>
    createComponent(MailSearchFilter, {
      requestUrl: input.requestUrl,
      search: resolveMailSearchRoute(new URL(input.requestUrl, "https://cloud.test")),
      folders: input.folders ?? [],
      folderId: input.folderId ?? null,
      localTags: input.localTags ?? [tag],
      quickSearch: quickSearch(input.summary ?? null),
      onOpenHref: () => {},
      onEditSearch: () => {},
      hint: { open: false, onDismiss: () => {} },
    }),
  );
const searchUrl = (expression: object, extra: Record<string, string> = {}) =>
  `/app/mail/Box001?${new URLSearchParams({ ...extra, search: JSON.stringify({ expression, sort: "newest" }) })}`;

test("the filter button names how many filters are active, from the server on, without IDs", () => {
  const quiet = render({ requestUrl: "/app/mail/Box001?folder=Fold01", folderId: "Fold01", folders: [mailTestFolder("Fold01")] });
  expect(quiet).toContain('aria-label="Filters"');
  expect(quiet).not.toContain('data-active="true"');
  const tagged = render({ requestUrl: searchUrl({ type: "local_tag_id", tagId: "Tag001" }) });
  expect(tagged).toContain('aria-label="Filters, 1 active"');
  expect(tagged).toContain('data-active="true"');
  expect(tagged).not.toContain("Tag001");
  const folder = mailTestFolder("Fold01");
  const two = render({
    requestUrl: searchUrl(
      {
        type: "and",
        expressions: [
          { type: "folder_id", folderId: "Fold01" },
          { type: "unread", folderId: "Fold01" },
          { type: "size", field: "attachment", operator: "at_least", bytes: 0 },
        ],
      },
      { folder: "Fold01" },
    ),
    folderId: "Fold01",
    folders: [folder],
  });
  expect(two).toContain('aria-label="Filters, 2 active"');
});

test("a structured search counts as one filter; its summary waits under More filters", () => {
  const html = render({
    requestUrl: searchUrl({ type: "text", field: "from", query: "billing@example.test", match: "exact" }),
    summary: "From is billing@example.test",
  });
  expect(html).toContain('aria-label="Filters, 1 active"');
});

test("the old chips' URL state stays the filter's state, so old links keep working", () => {
  // A link from the time of the head chips: unread in a folder.
  const html = render({
    requestUrl: searchUrl(
      {
        type: "and",
        expressions: [
          { type: "folder_id", folderId: "Fold01" },
          { type: "unread", folderId: "Fold01" },
        ],
      },
      { folder: "Fold01" },
    ),
    folderId: "Fold01",
    folders: [mailTestFolder("Fold01", { unread: 4 })],
  });
  expect(html).toContain('aria-label="Filters, 1 active"');
});
