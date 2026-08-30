import { describe, expect, test } from "bun:test";
import { checkNotificationWsMessages, notificationWsMessages } from "./notifications-ws-messages";

describe("notification WebSocket messages", () => {
  test("resolves concurrent connection locales independently", async () => {
    expect(checkNotificationWsMessages()).toEqual([]);
    const [english, german] = await Promise.all([
      Promise.resolve().then(() => notificationWsMessages("en").streamFailed),
      Promise.resolve().then(() => notificationWsMessages("de-CH").streamFailed),
    ]);
    expect(english).toBe("Notification event stream failed");
    expect(german).toBe("Der Benachrichtigungsstrom ist fehlgeschlagen");
  });
});
