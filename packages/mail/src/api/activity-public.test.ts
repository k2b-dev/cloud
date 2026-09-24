import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import { publicResources } from "../service";
import type { PublicActivityItem } from "../service/activity-public";
import { projectActivityResult } from "./activity-public";

afterEach(() => mock.restore());

describe("Mail activity API projection", () => {
  test("projects resource targets and metadata without exposing missing UUIDs", async () => {
    const attachmentId = "11111111-1111-4111-8111-111111111111";
    const messageId = "22222222-2222-4222-8222-222222222222";
    const missingTagId = "33333333-3333-4333-8333-333333333333";
    spyOn(publicResources, "publicIds").mockImplementation(async (table) =>
      table === "attachments" ? new Map([[attachmentId, "Atta01"]]) : table === "messages" ? new Map([[messageId, "Mess01"]]) : new Map(),
    );

    const items: PublicActivityItem[] = [
      {
        conversationId: null,
        targetType: "attachment",
        targetId: attachmentId,
        metadata: { messageId, addedTagIds: [missingTagId] },
      },
    ];
    const projected = await projectActivityResult(
      ok({
        items,
        nextCursor: null,
      }),
    );

    expect(projected).toEqual(
      ok({
        items: [
          {
            conversationId: null,
            targetType: "attachment",
            targetId: "Atta01",
            metadata: { messageId: "Mess01", addedTagIds: [null] },
          },
        ],
        nextCursor: null,
      }),
    );
  });
});
