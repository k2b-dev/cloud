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

test("panel links preserve a message deep link and round-trip through route parsing", () => {
  expect(panelHref("Chat01", "info", "Message001")).toBe("/app/chat/c/Chat01/m/Message001?panel=info");
  expect(panelHref("Chat01", null, "Message001")).toBe("/app/chat/c/Chat01/m/Message001");
  expect(panelHref("Chat /01", "info", "Message /001")).toBe("/app/chat/c/Chat%20%2F01/m/Message%20%2F001?panel=info");
  for (const panel of ["info", null] as const)
    expect(parseRoute(new URL(panelHref("Chat01", panel, "Message001"), "https://cloud.test"))).toEqual({
      chatId: "Chat01",
      messageId: "Message001",
      panel,
    });
});

test("provider navigation stays below the panel route, including list, info and message history", () => {
  for (const panel of ["info", null] as const) {
    const href = panelHref("Chat01", panel, "Message001", "/app/chat/panel");
    expect(href).toStartWith("/app/chat/panel/c/Chat01/m/Message001");
    expect(parseRoute(new URL(href, "https://cloud.test"))).toEqual({ chatId: "Chat01", messageId: "Message001", panel });
  }
  expect(parseRoute(new URL("https://cloud.test/app/chat/panel"))).toEqual({ chatId: null, messageId: null, panel: null });
  expect(parseRoute(new URL("https://cloud.test/app/chat/panel-other"))).toBeNull();
});
