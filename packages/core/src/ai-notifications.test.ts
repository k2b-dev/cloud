import { expect, spyOn, test } from "bun:test";
import { CHAT_TASK_REASON_CODES, chatTaskReasonSentence, chatTaskReasonState } from "@k2b/cloud/ai";
import { assertCapabilityReview } from "@k2b/cloud/capabilities/testing";
import { coreSettings } from "@k2b/cloud/services";
import { prepareNotificationEmail } from "@k2b/cloud/services/notifications/email-frame";
import { AI_NOTIFICATIONS } from "./ai-notifications";

for (const locale of ["de", "en"])
  for (const code of CHAT_TASK_REASON_CODES) {
    if (chatTaskReasonState(code) !== "needs_attention") continue;
    test(`routine notice ${locale}: ${code} names the routine and words the reason`, async () => {
      const data = { conversationId: "abc234", name: "Neue Rechnungen", code, at: "2026-04-07T13:45:00.000Z", timeZone: "Europe/Berlin" };
      const rendered = await AI_NOTIFICATIONS.taskNeedsAttention.render(data, { locale });
      expect(rendered.title).toBe(locale === "de" ? "„Neue Rechnungen“ braucht dich" : "“Neue Rechnungen” needs you");
      expect(rendered.body).toBe(chatTaskReasonSentence(data, { locale, timeZone: data.timeZone }));
      expect(`${rendered.title} ${rendered.body}`).not.toContain("abc234");
      expect(Object.keys(AI_NOTIFICATIONS.taskNeedsAttention.data.shape)).not.toContain("error");
      expect(Object.keys(AI_NOTIFICATIONS.taskNeedsAttention.data.shape)).not.toContain("taskId");
    });
  }

for (const locale of ["de", "en"]) {
  test(`approval notice uses the card's plain question and reason in ${locale}`, async () => {
    const { approvalCard } = await import("@k2b/cloud/ai/question-text");
    const input = {
      sentence: "Mail: Send draft",
      action: "draft.send",
      appName: "Mail",
      review: {
        locale,
        sentence: {
          action: locale === "de" ? "Mail an {to} senden" : "Send mail to {to}",
          running: locale === "de" ? "Mail an {to} wird gesendet" : "Sending mail to {to}",
          done: locale === "de" ? "Mail an {to} gesendet" : "Sent mail to {to}",
          confirm: locale === "de" ? "Senden" : "Send",
          decline: locale === "de" ? "Nicht senden" : "Don't send",
        },
        slots: { to: { kind: "person", people: [{ name: "Lea Berg", address: "lea.berg@example.com" }] } },
        ask: "sends",
      },
    } satisfies Parameters<typeof approvalCard>[0];
    assertCapabilityReview(input.review);
    const card = approvalCard(input, locale, "UTC");
    const rendered = await AI_NOTIFICATIONS.approvalWaiting.render(
      { count: 1, question: card.questionText, reason: card.reason.text },
      { locale },
    );
    expect(rendered).toEqual({
      title: locale === "de" ? "Freigabe wartet" : "Approval waiting",
      body:
        locale === "de"
          ? "Mail an Lea Berg <lea.berg@example.com> senden?\nIch frage, weil das Cloud verlässt."
          : "Send mail to Lea Berg <lea.berg@example.com>?\nI'm asking because this leaves Cloud.",
      targetHref: "/me/approvals",
    });
    const old = await AI_NOTIFICATIONS.approvalWaiting.render({ count: 3 }, { locale });
    expect(old.title).toBe(locale === "de" ? "3 Freigaben warten" : "3 approvals waiting");
    expect(old.body).toBe(
      locale === "de"
        ? "Eine Aktion wartet auf deine Freigabe. Bis du entscheidest, passiert nichts."
        : "An Action waits for your approval. Nothing happens until you decide.",
    );
    expect(Object.keys(AI_NOTIFICATIONS.approvalWaiting.data.shape)).not.toContain("locale");
    const setting = spyOn(coreSettings, "get").mockResolvedValue("https://cloud.example");
    try {
      const email = await AI_NOTIFICATIONS.approvalWaiting.email!(
        { count: 1, question: card.questionText, reason: card.reason.text },
        { locale },
      );
      expect(email.subject).toBe(rendered.title);
      // The delivered mail keeps the address: the question goes out as escaped HTML, not as HTML-read plain text.
      const delivered = await prepareNotificationEmail(email);
      expect(delivered.text).toBe(
        `${rendered.body?.replace("\n", " ")} ${locale === "de" ? "Öffne sie unter" : "Open it at"} https://cloud.example/me/approvals`,
      );
      expect(delivered.html).toContain("Lea Berg &lt;lea.berg@example.com&gt;");
      const oldEmail = await AI_NOTIFICATIONS.approvalWaiting.email!({ count: 1 }, { locale });
      expect(oldEmail.content).toBe(`${old.body} ${locale === "de" ? "Öffne sie unter" : "Open it at"} https://cloud.example/me/approvals`);
    } finally {
      setting.mockRestore();
    }
  });
}
