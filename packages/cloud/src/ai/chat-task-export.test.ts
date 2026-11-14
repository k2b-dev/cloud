import { expect, test } from "bun:test";
import { ChatTaskExportQuerySchema } from "./chat-task-export";

test("routine export page selection cannot select another owner or exceed its page budget", () => {
  expect(ChatTaskExportQuerySchema.parse({})).toEqual({ limit: 100 });
  for (const input of [{ userId: "someone-else" }, { all: true }, { limit: 101 }, { after: "invalid" }])
    expect(ChatTaskExportQuerySchema.safeParse(input).success).toBe(false);
});
