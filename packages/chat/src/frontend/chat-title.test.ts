import { describe, expect, test } from "bun:test";
import { derivePageTrail } from "@k2b/cloud/ssr/page-trail";
import { chatTitle } from "./chat-title";

const trail = (title: string | undefined, ownBack: boolean, listHref = "/app/chat/archive") =>
  derivePageTrail(chatTitle({ start: "Start", appName: "Chat", title, listHref, ownBack }), "/app/chat", "Chat");

describe("Chat reports its page to the shell", () => {
  test("For You and the channel directory leave the way back to their own Back to chats", () => {
    expect(trail("For you", true)).toEqual({ title: "For you", ancestors: [] });
    expect(trail("Browse channels", true, "/app/chat?filter=unread")).toEqual({ title: "Browse channels", ancestors: [] });
  });

  test("a chat below the archive or Unread list still leads up to that list", () => {
    expect(trail("Design", false)).toEqual({ title: "Design", ancestors: [{ title: "Chat", href: "/app/chat/archive" }] });
    expect(trail("Design", false, "/app/chat?filter=unread").ancestors).toEqual([{ title: "Chat", href: "/app/chat?filter=unread" }]);
  });

  test("the plain list is the app itself", () => {
    expect(trail(undefined, false)).toEqual({ title: "Chat", ancestors: [] });
  });
});
