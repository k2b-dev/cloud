import { describe, expect, test } from "bun:test";
import { executeMailBulkAction, MAIL_BULK_CONCURRENCY, MAIL_BULK_NO_PROVIDER_PLACEMENT } from "./mail-bulk-actions";

describe("Mail bulk actions", () => {
  test("bounds concurrency and reports per-conversation partial failures", async () => {
    let active = 0;
    let maximumActive = 0;
    const targets = Array.from({ length: 8 }, (_, index) => ({
      conversationId: `conversation-${index}`,
      label: `Conversation ${index}`,
      sourceFolderIds: index === 3 ? ["first", "fails"] : ["folder"],
    }));
    const result = await executeMailBulkAction({
      actionId: "archive",
      targets,
      submit: async (target, sourceFolderId) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Bun.sleep(2);
        active -= 1;
        if (target.conversationId === "conversation-3" && sourceFolderId === "fails") throw new Error("Provider rejected placement");
      },
    });
    expect(maximumActive).toBeLessThanOrEqual(MAIL_BULK_CONCURRENCY);
    expect(result.succeededConversationIds).toHaveLength(7);
    expect(result.failures).toEqual([
      {
        conversationId: "conversation-3",
        label: "Conversation 3",
        message: "Provider rejected placement",
        submittedPlacements: 1,
      },
    ]);
  });

  test("fails targets without a provider placement explicitly", async () => {
    const result = await executeMailBulkAction({
      actionId: "trash",
      targets: [{ conversationId: "missing", label: "Missing", sourceFolderIds: [] }],
      submit: async () => undefined,
    });
    expect(result.succeededConversationIds).toEqual([]);
    expect(result.failures[0]?.message).toBe(MAIL_BULK_NO_PROVIDER_PLACEMENT);
  });
});
