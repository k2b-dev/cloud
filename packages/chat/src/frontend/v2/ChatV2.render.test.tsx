import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";
import { chatMessages } from "../../messages";
import type { ChatWorkspaceProps } from "../ChatWorkspace.island";
import { chatV2Messages } from "./chat-v2-messages";

const root = mkdtempSync(resolve(tmpdir(), "chat-v2-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { LocaleProvider } = await import("@k2b/ui");
const { default: ChatWorkspaceV2 } = await import("../ChatWorkspaceV2.island");
const now = "2026-11-26T10:30:00.000Z";
const viewerId = "11111111-1111-4111-8111-111111111111";
type Conversation = NonNullable<ChatWorkspaceProps["open"]>["conversation"];
const chat = (id: string, title: string, extra: Partial<Conversation> = {}): Conversation => ({
  notifications: null,
  mentionsUnread: 0,
  threads: 0,
  channel: false,
  member: true,
  id,
  name: title,
  title,
  icon: null,
  purpose: null,
  memberCount: 3,
  unread: 0,
  read: { lastReadSeq: null, unreadFromSeq: null, joinedSeq: 0 },
  archived: false,
  pinnedRank: null,
  withGuests: false,
  peerDeactivated: false,
  permission: "write",
  rev: 1,
  createdAt: now,
  lastActivityAt: now,
  lastMessage: null,
  ...extra,
});
const rows = [
  chat("Chat01", "Werkstatt Nord", { pinnedRank: 0, unread: 2 }),
  chat("Chat02", "Nora Weber", { unread: 3 }),
  chat("Chat03", "Lieferung KW 49"),
  chat("Chat04", "Ankündigungen", { channel: true, purpose: "News for the whole team", memberCount: 12 }),
];
const props = (extra: Partial<ChatWorkspaceProps> = {}): ChatWorkspaceProps => ({
  cursor: "c.0",
  sidebar: { items: rows, nextCursor: null },
  open: null,
  chatId: null,
  view: "all",
  threadsPage: false,
  guest: false,
  panel: null,
  viewerId,
  dateConfig: { timeZone: "UTC", firstDayOfWeek: 1 },
  now,
  ...extra,
});
const render = (locale: string, data: ChatWorkspaceProps) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(ChatWorkspaceV2, data);
      },
    }),
  );

describe("Chat v2 server render", () => {
  for (const locale of ["en", "de-DE"]) {
    const t = chatMessages.resolve([locale]).t;
    const v2 = chatV2Messages.resolve([locale]).t;
    test(`the list renders its chats in v2's frame with data and no loading state in ${locale}`, () => {
      const html = render(locale, props());
      expect(html).toContain('data-k2-part="Workspace"');
      expect(html).toContain('data-k2-part="Nav"');
      // The nav counts unread chats; without a mention the list stands without a statement of its own.
      expect(html).not.toContain('data-k2-part="StatusRow"');
      for (const title of ["Werkstatt Nord", "Nora Weber", "Lieferung KW 49", "Ankündigungen"]) expect(html).toContain(title);
      for (const section of [t.pinnedChats, v2.directAndGroups, t.channels]) expect(html).toContain(section);
      // The first render has its data: no loading placeholder and no busy region.
      expect(html).not.toContain('data-k2-part="Loading"');
      expect(html).not.toContain('aria-busy="true"');
      // Nothing is open: the detail's place says so; v1's frame is not drawn.
      expect(html).toContain(v2.noneOpen);
      expect(html).not.toContain("chat-list-page");
    });
    test(`a mention is the one statement over the list in ${locale}`, () => {
      const html = render(
        locale,
        props({ sidebar: { items: [...rows, chat("Chat05", "Lager-Team", { unread: 2, mentionsUnread: 2 })], nextCursor: null } }),
      );
      expect(html).toContain('data-k2-part="StatusRow"');
      expect(html).toContain(v2.mentions({ count: (2).toLocaleString(locale), names: "Lager-Team" }));
    });
    test(`an empty list says there are no chats yet in ${locale}`, () => {
      const html = render(locale, props({ sidebar: { items: [], nextCursor: null } }));
      expect(html).toContain(t.noneYet);
      // One section alone has no heading: the nav names the list.
      expect(html).not.toContain(v2.directAndGroups);
    });
  }
});
