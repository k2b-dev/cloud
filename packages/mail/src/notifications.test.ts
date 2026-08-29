import { describe, expect, test } from "bun:test";
import { NOTIFICATIONS } from "./notifications";

const reminder = {
  mailboxId: "Box001",
  conversationId: "Conv01",
  sourceId: "Rem001",
  subject: "Follow up",
};

describe("Mail public notifications", () => {
  test("accepts only short resource IDs and renders a short-only target", async () => {
    expect(NOTIFICATIONS.conversationReminder.data.safeParse(reminder).success).toBeTrue();
    expect(
      NOTIFICATIONS.conversationReminder.data.safeParse({
        ...reminder,
        mailboxId: "1da425e0-6bea-47ee-95a4-9d2151802171",
      }).success,
    ).toBeFalse();

    expect(await NOTIFICATIONS.conversationReminder.render(reminder, { locale: "en" })).toEqual({
      title: "Mail reminder",
      body: "Follow up",
      targetHref: "/api/mail/mailboxes/Box001/notification-targets/reminder/Rem001",
    });
  });

  test("keeps workflow notification links on the public mailbox ID", async () => {
    const data = { mailboxId: "Box001", title: "Done", body: "The workflow finished." };
    expect(NOTIFICATIONS.workflowNotice.data.safeParse(data).success).toBeTrue();
    expect(await NOTIFICATIONS.workflowNotice.render(data, { locale: "en" })).toEqual({
      title: "Done",
      body: "The workflow finished.",
      targetHref: "/app/mail/Box001",
    });
  });
});
