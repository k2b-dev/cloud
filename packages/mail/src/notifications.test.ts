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

  test("renders one batched assignment notice in the sender's locale", async () => {
    const batch = { mailboxId: "Box001", mailboxName: "Support", conversationIds: ["Conv01", "Conv02"], assignedBy: "Maria" };
    expect(NOTIFICATIONS.conversationsAssigned.data.safeParse(batch).success).toBeTrue();
    expect(NOTIFICATIONS.conversationsAssigned.data.safeParse({ ...batch, conversationIds: [] }).success).toBeFalse();
    expect(await NOTIFICATIONS.conversationsAssigned.render(batch, { locale: "de" })).toEqual({
      title: "2 Unterhaltungen wurden dir zugewiesen",
      body: "Maria in Support",
      targetHref: "/app/mail/Box001?view=mine",
    });
    expect(
      await NOTIFICATIONS.conversationsAssigned.render({ ...batch, conversationIds: ["Conv01"], assignedBy: null }, { locale: "en" }),
    ).toEqual({
      title: "A conversation was assigned to you",
      body: "Support",
      targetHref: "/app/mail/Box001?conversation=Conv01",
    });
  });

  test("tells the sender once that a message waits for sign-in, and once that it went back to the drafts", async () => {
    const waiting = { mailboxId: "Box001", mailboxName: "Support", subject: "Offer", scheduled: true, notice: "waiting" as const };
    expect(NOTIFICATIONS.sendWaitingForLogin.data.safeParse({ ...waiting, mailboxId: crypto.randomUUID() }).success).toBeFalse();
    expect(await NOTIFICATIONS.sendWaitingForLogin.render(waiting, { locale: "en" })).toEqual({
      title: "A message is waiting to be sent",
      body: "Support needs to be signed in again. Mail sends “Offer” as soon as the account is reconnected.",
      targetHref: "/app/mail/Box001?scheduled=1",
    });
    expect(await NOTIFICATIONS.sendWaitingForLogin.render({ ...waiting, scheduled: false }, { locale: "en" })).toMatchObject({
      targetHref: "/app/mail/Box001",
    });
    expect(await NOTIFICATIONS.sendWaitingForLogin.render({ ...waiting, subject: "", notice: "returned" }, { locale: "de" })).toEqual({
      title: "Eine Nachricht konnte nicht gesendet werden",
      body: "Support wurde nicht rechtzeitig wieder verbunden. „(kein Betreff)“ liegt wieder in deinen Entwürfen.",
      targetHref: "/app/mail/Box001?view=send_problems",
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
