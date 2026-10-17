import { expect, test } from "bun:test";
import { CHAT_TASK_REASON_CODES, chatTaskReasonSentence, chatTaskReasonState } from "@k2b/cloud/ai";
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
