import { expect, test } from "bun:test";
import { panelHref, parseRoute } from "./route";

test("info links and route parsing preserve only a valid chat panel", () => {
  expect(panelHref("Chat01", null)).toBe("/app/chat/c/Chat01");
  expect(panelHref("Chat01", "info")).toBe("/app/chat/c/Chat01?panel=info");
  expect(parseRoute(new URL("https://cloud.test/app/chat/c/Chat01?panel=info"))).toEqual({
    chatId: "Chat01",
    messageId: null,
    panel: "info",
  });
  expect(parseRoute(new URL("https://cloud.test/app/chat/c/Chat01/m/Message001?panel=info"))).toEqual({
    chatId: "Chat01",
    messageId: "Message001",
    panel: "info",
  });
  expect(parseRoute(new URL("https://cloud.test/app/chat/c/Chat01?panel=other"))?.panel).toBeNull();
  expect(parseRoute(new URL("https://cloud.test/app/chat?panel=info"))).toEqual({ chatId: null, messageId: null, panel: null });
  expect(parseRoute(new URL("https://cloud.test/app/other"))).toBeNull();
});
