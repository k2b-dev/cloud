import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { Mailbox } from "../../contracts";
import { resolveMailSearchRoute } from "../../search-state";
import { mailTestRow } from "./mail-list-test-fixtures";

const root = mkdtempSync(join(tmpdir(), "mail-conversation-list-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: MailConversationList } = await import("./MailConversationList.tsx");

const mailbox = { id: "Box001", name: "Support", health: "healthy" } as unknown as Mailbox;

const renderList = (overrides: Partial<Parameters<typeof MailConversationList>[0]> = {}) =>
  renderToString(() =>
    createComponent(MailConversationList, {
      mailbox,
      mailboxId: mailbox.id,
      requestUrl: "/app/mail/Box001?view=needs_action",
      query: "",
      search: resolveMailSearchRoute(new URL(overrides.requestUrl ?? "/app/mail/Box001?view=needs_action", "https://cloud.test")),
      title: "Needs action",
      namedBy: "tabs",
      items: [],
      error: null,
      selectedConversationId: null,
      selectedMessageId: null,
      selectedConversationIds: new Set<string>(),
      selectionMode: false,
      nextCursor: null,
      dateConfig: { locale: "en", timeZone: "UTC" },
      canWrite: true,
      canAdmin: false,
      viewFolderId: null,
      folders: [],
      localTags: [],
      savedViews: [],
      activeSavedViewId: null,
      listMode: "conversations",
      loading: false,
      liveDegraded: false,
      onCollapse: () => {},
      onOpenHealth: () => {},
      onOpenDeliverySettings: () => {},
      onNavigate: () => {},
      onNavigateItem: () => {},
      onToggleSelectionMode: () => {},

      onToggleSelection: () => {},
      onClearSelection: () => {},
      onAddTags: () => {},
      onAssign: () => {},
      onBulkAction: () => {},
      onItemAction: () => {},
      onManageTags: () => {},
      onRespondItem: () => {},
      onSetItemCompletion: () => {},
      currentUserId: null,
      assigneeNames: () => [],
      onMergeItem: () => {},
      onOpenHref: () => {},
      onLoadMore: () => true,
      onRefresh: async () => {},
      ...overrides,
    }),
  );

describe("Mail conversation list", () => {
  test("wraps only the list scrollport in pull-to-refresh and keeps the header outside it", () => {
    const html = renderList();
    const wrapper = html.indexOf('class="k2b-pull-to-refresh flex-1"');
    const heading = html.indexOf("data-mail-list-heading");
    const port = html.indexOf('data-scroll-preserve="mail-list-Box001"');

    expect(wrapper).toBeGreaterThan(-1);
    expect(heading).toBeGreaterThan(-1);
    expect(heading).toBeLessThan(wrapper);
    expect(port).toBeGreaterThan(wrapper);
    expect(html.match(/class="k2b-pull-to-refresh /g)).toHaveLength(1);
    expect(html).toContain('data-state="idle"');
    expect(html).toContain("Needs action");
  });

  test("keeps the semantic list heading and puts its shown count after the rows", () => {
    const html = renderList({
      requestUrl: `/app/mail/Box001?${new URLSearchParams({ search: JSON.stringify({ expression: { type: "local_tag_id", tagId: "Tag001" }, sort: "newest" }) })}`,
    });
    expect(html).toMatch(/<h1[^>]*data-mail-list-heading[^>]*class="sr-only"[^>]*>Needs action<\/h1>/);
    expect(html).not.toContain('role="search"');
    expect(html).toContain("data-mail-list-count");
    expect(html).not.toContain("mail-search-summary");
    expect(html).not.toContain('aria-label="Choose list view"');
  });

  test("keeps the list heading semantic; the workspace head names folders when needed", () => {
    const folder = renderList({ requestUrl: "/app/mail/Box001?folder=Fld001", title: "Archive", namedBy: "sidebar" });
    // Visible naming now belongs to the workspace head.
    expect(folder).toMatch(/<h1[^>]*data-mail-list-heading[^>]*class="sr-only"[^>]*>Archive<\/h1>/);
    expect(renderList({ namedBy: "tabs" })).toMatch(/<h1[^>]*data-mail-list-heading[^>]*class="sr-only"[^>]*>Needs action<\/h1>/);
  });

  test("keeps a semantic folder heading when no sidebar row names it", () => {
    const folder = renderList({ requestUrl: "/app/mail/Box001?folder=Quiet1", title: "Quiet", namedBy: null });
    const headingClass = folder.match(/<h1[^>]*data-mail-list-heading[^>]*class="([^"]*)"[^>]*>Quiet<\/h1>/)?.[1];
    expect(headingClass).toBe("sr-only");
    expect(headingClass).not.toContain("mail-list-heading");
  });

  test("explains a failed search instead of showing service text", () => {
    const html = renderList({ error: "search_failed" });
    expect(html).toContain("Could not load conversations");
    expect(html).toContain("The search could not run. Try again, and change the search conditions if it keeps failing.");
    expect(html).toContain("Retry");
  });
});

describe("Mail Assigned to me groups", () => {
  const mine = { requestUrl: "/app/mail/Box001?view=mine", title: "Assigned to me", assignedGroups: { needsAction: 12, waiting: 3 } };
  const done = { count: null, more: false, href: "/app/mail/Box001?search=done" };

  test("nothing open assigned: names it calmly and still offers the done conversations", () => {
    const html = renderList({ ...mine, hiddenDone: done });
    expect(html).toContain("Nothing open is assigned to you");
    expect(html).toContain("New assignments appear here and in your notifications.");
    expect(html).toContain("ti-mood-smile");
    expect(html).toContain("Done conversations that were assigned to you");
    expect(html).toContain("Show done");
    expect(html).not.toContain("data-mail-assigned-group");
  });

  test("heads each group once with the view's count, not the page's, and leaves out day headings", () => {
    const items = [
      mailTestRow("Conv01", { workStatus: "needs_action" }),
      mailTestRow("Conv02", { workStatus: "needs_action" }),
      mailTestRow("Conv03", { workStatus: "waiting" }),
    ];
    const html = renderList({ ...mine, items, hiddenDone: done });
    expect(html.match(/data-mail-assigned-group="needsAction"/g)?.length).toBe(1);
    expect(html.match(/data-mail-assigned-group="waiting"/g)?.length).toBe(1);
    expect(html).toContain("Your turn · 12");
    expect(html).toContain("Waiting for reply · 3");
    expect(html.indexOf("Your turn")).toBeLessThan(html.indexOf('data-conversation-id="Conv01"'));
    expect(html.indexOf('data-conversation-id="Conv02"')).toBeLessThan(html.indexOf("Waiting for reply"));
    expect(html.indexOf("Waiting for reply")).toBeLessThan(html.indexOf('data-conversation-id="Conv03"'));
    expect(html).not.toContain("data-mail-day-group");
  });

  test("a waiting group that has not loaded yet gets no heading; other views keep day headings", () => {
    const html = renderList({ ...mine, items: [mailTestRow("Conv01", { workStatus: "needs_action" })], nextCursor: "next" });
    expect(html).toContain("Your turn · 12");
    expect(html).not.toContain("Waiting for reply");
    expect(renderList({ items: [mailTestRow("Conv01")] })).toContain("data-mail-day-group");
  });
});
