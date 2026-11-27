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
      // Two columns (Valentin, v8): the chats are the nav's own rows under its search and "New chat", the phone's page;
      // there is no list pane, no head bar and no "Chats" entry of their own.
      expect(html).toContain('class="k2-nav-search"');
      expect(html).toContain('class="k2-nav-primary"');
      expect(html).toMatch(/class="k2-nav-list" data-phone="page">(?:(?!<\/nav>).)*Werkstatt Nord/s);
      expect(html).not.toContain('data-slot="head"><button');
      expect(html).not.toContain(`<span class="k2-ni-name">${t.chats}</span>`);
      expect(html).not.toContain('data-k2-part="StatusRow"');
      // One list without headings: the pinned chat first, marked with its pin, then the chats and channels.
      const order = ["Werkstatt Nord", "Nora Weber", "Lieferung KW 49", "Ankündigungen"].map((title) => html.indexOf(title));
      expect(order.every((at, index) => at > 0 && (index === 0 || at > order[index - 1]!))).toBe(true);
      expect(html).toContain(`aria-label="${t.pinnedChats}"`);
      expect(html.match(/data-k2-part="List"/g)?.length).toBe(1);
      expect(html).not.toContain('data-k2-part="Section"');
      // The first render has its data: no loading placeholder and no busy region.
      expect(html).not.toContain('data-k2-part="Loading"');
      expect(html).not.toContain('aria-busy="true"');
      // Nothing is open: the detail's place says so; v1's frame is not drawn.
      expect(html).toContain(v2.noneOpen);
      expect(html).not.toContain("chat-list-page");
    });
    test(`a mention is said once, on its chat's row, with no statement above the chats, in ${locale}`, () => {
      const html = render(
        locale,
        props({ sidebar: { items: [...rows, chat("Chat05", "Lager-Team", { unread: 2, mentionsUnread: 2 })], nextCursor: null } }),
      );
      expect(html).not.toContain('data-k2-part="StatusRow"');
      expect(html).toMatch(/Lager-Team<\/span><span class="k2-row-meta">(?:<!--!\$-->)*2<\/span>/);
      // the frame has no head of its own that could hold a statement
      expect(html).not.toContain('data-k2-part="Bar"><div class="k2-bar-start"><span');
    });
    // A place opens on its General stream with its discussions as cards, on the server too: the card's link is built
    // without the browser's location (a reference to it answered the page with 500).
    test(`a place's General stream renders its discussions as cards on the server in ${locale}`, () => {
      const place = chat("Place01", "Frühlingsausstellung", {
        kind: "system",
        resource: { type: "spaces.space", id: "Space1" },
        threads: 1,
      });
      const html = render(
        locale,
        props({
          chatId: place.id,
          view: "general",
          sidebar: { items: [...rows, place], nextCursor: null },
          open: {
            conversation: place,
            page: { items: [], seqHead: 0, rev: 1, from: 1, to: 0 },
            focus: null,
            threads: {
              nextCursor: null,
              general: { unread: 0, lastMessage: null },
              items: [
                {
                  id: "Thread01",
                  name: "Besichtigung",
                  description: null,
                  archived: false,
                  unread: 1,
                  read: null,
                  lastMessage: null,
                  lastActivityAt: now,
                  createdAt: now,
                  resource: {
                    ref: { type: "spaces.item", id: "Item1" },
                    title: "Besichtigung",
                    permission: "read",
                    typeTitle: "Item",
                    icon: "ti ti-package",
                    status: "Offen",
                  },
                },
              ],
            },
          },
        }),
      );
      expect(html).toContain('class="chat-discussion"');
      expect(html).toContain("Besichtigung");
      expect(html).toContain('href="/app/chat/c/Place01/t/Thread01"');
    });
    test(`an empty list says there are no chats yet in ${locale}`, () => {
      const html = render(locale, props({ sidebar: { items: [], nextCursor: null } }));
      expect(html).toContain(t.noneYet);
      // The list has no heading: the nav names it.
      expect(html).not.toContain('data-k2-part="Section"');
    });
  }
});
