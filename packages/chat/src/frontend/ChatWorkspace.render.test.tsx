import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { chatMessages } from "../messages";
import type { ChatWorkspaceProps } from "./ChatWorkspace.island";

const root = mkdtempSync(resolve(tmpdir(), "chat-workspace-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { LocaleProvider } = await import("@k2b/ui");
const { default: ChatWorkspace } = await import("./ChatWorkspace.island");
const now = "2026-10-12T10:30:00.000Z";
const viewerId = "11111111-1111-4111-8111-111111111111";
const conversation: NonNullable<ChatWorkspaceProps["open"]>["conversation"] = {
  id: "Chat01",
  name: "Delivery board",
  title: "Delivery board",
  icon: null,
  purpose: null,
  memberCount: 3,
  withGuests: false,
  peerDeactivated: false,
  permission: "write",
  rev: 1,
  createdAt: now,
  lastActivityAt: now,
  lastMessage: null,
};
const props = (): ChatWorkspaceProps => ({
  cursor: "c.0",
  sidebar: { items: [], nextCursor: null },
  open: null,
  chatId: null,
  viewerId,
  dateConfig: { timeZone: "UTC", firstDayOfWeek: 1 },
  now,
});
const render = (locale: string, data: ChatWorkspaceProps) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(ChatWorkspace, data);
      },
    }),
  );

describe("ChatWorkspace server render", () => {
  for (const locale of ["en", "de-DE"]) {
    const t = chatMessages.resolve([locale]).t;
    test(`empty sidebar and work area in ${locale}`, () => {
      const html = render(locale, props());
      expect(html).toContain(t.noneYet);
      expect(html).toContain(t.noChatsTitle);
      expect(html).toContain(t.noChatsDescription);
    });
    test(`list titles, sender previews, times and selection placeholder in ${locale}`, () => {
      const rows: ChatWorkspaceProps["sidebar"]["items"] = [
        {
          ...conversation,
          id: "Chat01",
          title: "Own last message",
          lastMessage: {
            id: "Chat010001",
            author: { type: "user", id: viewerId, name: "Robin" },
            preview: "Sent the invoice",
            createdAt: now,
          },
        },
        {
          ...conversation,
          id: "Chat02",
          title: "Two people",
          memberCount: 2,
          withGuests: false,
          peerDeactivated: false,
          lastMessage: {
            id: "Chat020001",
            author: { type: "user", id: "22222222-2222-4222-8222-222222222222", name: "Nora Weber" },
            preview: "Arriving soon",
            createdAt: now,
          },
        },
        {
          ...conversation,
          id: "Chat03",
          title: "Group chat",
          lastMessage: {
            id: "Chat030001",
            author: { type: "user", id: "22222222-2222-4222-8222-222222222222", name: "Nora Weber" },
            preview: "Bring photos",
            createdAt: now,
          },
        },
        { ...conversation, id: "Chat04", title: "Empty chat", lastActivityAt: "2026-10-11T10:30:00.000Z" },
      ];
      const html = render(locale, { ...props(), sidebar: { items: rows, nextCursor: null } });
      for (const row of rows) expect(html).toContain(row.title);
      for (const line of [
        t.ownPreview({ text: "Sent the invoice" }),
        "Arriving soon",
        t.senderPreview({ name: "Nora", text: "Bring photos" }),
        t.noMessagesYet,
      ])
        expect(html).toContain(line);
      expect(html).toContain('datetime="2026-10-12T10:30:00.000Z"');
      expect(html).toContain("10:30");
      expect(html).toContain(t.yesterday);
      expect(html).toContain(t.selectChatTitle);
    });
    for (const permission of ["write", "read"] as const) {
      test(`open ${permission} chat header and composer in ${locale}`, () => {
        const data = props();
        data.chatId = conversation.id;
        data.open = { conversation: { ...conversation, permission }, page: { items: [], seqHead: 0, rev: 1 }, focus: null };
        const html = render(locale, data);
        expect(html).toContain(conversation.title);
        expect(html).toContain(t.members({ count: 3 }));
        expect(html).toContain(`placeholder="${t.composerPlaceholder({ title: conversation.title })}"`);
        if (permission === "read") {
          expect(html).toMatch(/<textarea[^>]*disabled/);
          expect(html).toContain(t.readOnly);
        } else expect(html).not.toContain(t.readOnly);
      });
    }
    test(`no access reveals neither chat title nor address identifier in ${locale}`, () => {
      const html = render(locale, { ...props(), chatId: "Secret", open: null });
      expect(html).toContain(t.noAccessTitle);
      expect(html).toContain(t.noAccessDescription);
      expect(html).not.toContain("Secret board");
      expect(html).not.toContain("Secret");
    });
  }
});
