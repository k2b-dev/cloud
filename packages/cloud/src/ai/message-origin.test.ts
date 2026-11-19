import { expect, test } from "bun:test";
import { projectAiMessageOrigins } from "./message-origin";
import { AiMessageOriginSchema } from "./queue-contracts";

test.each([
  { locale: "de", name: "Wecker" },
  { locale: "en", name: "Alarm" },
])("alarm provenance survives queue projection in $locale", async ({ locale, name }) => {
  const id = "11111111-1111-4111-8111-111111111111";
  const [origin] = await projectAiMessageOrigins([{ kind: "wakeup", id, scheduledAt: "2026-11-18T12:00:00.000Z" }], { locale });
  expect(AiMessageOriginSchema.parse(origin)).toEqual({ kind: "wakeup", id, name });
});
