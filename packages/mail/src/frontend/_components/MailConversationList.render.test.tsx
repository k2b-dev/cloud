import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { Mailbox } from "../../contracts";

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
      title: "Needs action",
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
      junkFolderIds: [],
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
      onListModeChange: () => {},
      onToggleSelection: () => {},
      onClearSelection: () => {},
      onAddTags: () => {},
      onBulkAction: () => {},
      onItemAction: () => {},
      onManageTags: () => {},
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
    const search = html.indexOf('role="search"');
    const port = html.indexOf('data-scroll-preserve="mail-list-Box001"');

    expect(wrapper).toBeGreaterThan(-1);
    expect(search).toBeLessThan(wrapper);
    expect(port).toBeGreaterThan(wrapper);
    expect(html.match(/class="k2b-pull-to-refresh /g)).toHaveLength(1);
    expect(html).toContain('data-state="idle"');
    expect(html).toContain("Needs action");
  });
});
