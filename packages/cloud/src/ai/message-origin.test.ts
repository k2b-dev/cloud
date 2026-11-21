import { expect, test } from "bun:test";
import { z } from "zod";
import { AiChatOriginSchema } from "./chat-origin";
import { projectAiMessageOrigin, projectAiMessageOrigins, readerResourceName } from "./message-origin";
import { AiMessageOriginSchema, AiQueuedMessageSchema } from "./queue-contracts";

// Fictitious personal Code "Morgenbriefing" that writes to its own chat (Automationen als Code v5, #3665).
const code = { type: "core.code", id: "c_brief1" };

test("Code's own reader names and links it: by its reference, or by its canonical view with the open link", () => {
  expect(
    readerResourceName(
      { data: { view: { title: "Morgenbriefing", permission: "write" } }, links: [{ rel: "open", href: "/app/assistant/code/c_brief1" }] },
      code,
    ),
  ).toEqual({ name: "Morgenbriefing", href: "/app/assistant/code/c_brief1" });
  expect(readerResourceName({ data: { view: { title: "Morgenbriefing", permission: "read" } } }, code)).toEqual({ name: "Morgenbriefing" });
  expect(readerResourceName({ data: {}, refs: [{ ...code, title: "Morgenbriefing" }] }, code)).toEqual({ name: "Morgenbriefing" });
  // An answer that names nothing leaves the name to the fallback.
  expect(readerResourceName({ data: { items: [] } }, code)).toBeNull();
});

test("a reader with access sees the automation's name and link; without, it reads only as an automation, never as a name", () => {
  const origin = { kind: "automation" as const, id: "c_brief1", runId: "r1", resource: code };
  expect(projectAiMessageOrigin(origin, undefined, { name: "Morgenbriefing", href: "/app/assistant/code/c_brief1" })).toEqual({
    kind: "automation",
    id: "c_brief1",
    name: "Morgenbriefing",
    href: "/app/assistant/code/c_brief1",
  });
  // The reader refused (no right to read the Code) or failed: no link, and the name says it is unknown.
  expect(projectAiMessageOrigin(origin, undefined, null)).toEqual({ kind: "automation", id: "c_brief1", name: "Automation", named: false });
  // A service account's stored name still names it.
  expect(projectAiMessageOrigin({ kind: "automation", id: "sa1" }, { name: "Postfach info@", href: null }, null)).toEqual({
    kind: "automation",
    id: "sa1",
    name: "Postfach info@",
  });
  expect(projectAiMessageOrigin({ kind: "person", id: "u1" }, { name: "Lena Vogt", href: "/x" }, null)).toEqual({
    kind: "person",
    id: "u1",
    name: "Lena Vogt",
  });
});

test("an automation origin carries its resource, while origins written before it stay valid", () => {
  expect(AiChatOriginSchema.parse({ kind: "automation", id: "c_brief1", runId: "r1", resource: code })).toEqual({
    kind: "automation",
    id: "c_brief1",
    runId: "r1",
    resource: code,
  });
  expect(AiChatOriginSchema.parse({ kind: "automation", id: "c_brief1", runId: "r1" })).toEqual({
    kind: "automation",
    id: "c_brief1",
    runId: "r1",
  });
  expect(AiChatOriginSchema.safeParse({ kind: "automation", id: "c_brief1", resource: { type: "core.code" } }).success).toBe(false);
});

test("history and receipt origins share a JSON Schema definition without changing their validation", () => {
  const schema = z.toJSONSchema(z.strictObject({ message: AiChatOriginSchema, receipt: AiChatOriginSchema }));
  expect(schema.$defs?.AiChatOrigin).toBeDefined();
  const transport = z.fromJSONSchema(schema);
  const alarm = { kind: "wakeup", id: "11111111-1111-4111-8111-111111111111", scheduledAt: "2026-11-18T12:00:00.000Z" };
  for (const origin of [
    { kind: "person", id: "u1" },
    { kind: "automation", id: "c_brief1", resource: code },
    { kind: "chat", id: "chat1", turnId: "turn1" },
    alarm,
  ]) {
    expect(transport.parse({ message: origin, receipt: origin })).toEqual({ message: origin, receipt: origin });
  }
  for (const origin of [
    { ...alarm, id: "invalid" },
    { ...alarm, scheduledAt: "invalid" },
    { ...alarm, href: "/unexpected" },
  ]) {
    expect(AiChatOriginSchema.safeParse(origin).success).toBe(false);
    expect(transport.safeParse({ message: origin, receipt: origin }).success).toBe(false);
  }
});

test.each([
  { locale: "de", name: "Wecker" },
  { locale: "en", name: "Alarm" },
])("alarm provenance survives queue projection in $locale", async ({ locale, name }) => {
  const id = "11111111-1111-4111-8111-111111111111";
  const [origin] = await projectAiMessageOrigins([{ kind: "wakeup", id, scheduledAt: "2026-11-18T12:00:00.000Z" }], { locale });
  const projected = AiMessageOriginSchema.parse(origin);
  expect(projected).toEqual({ kind: "wakeup", id, name, scheduledAt: "2026-11-18T12:00:00.000Z" });
  expect(projectAiMessageOrigin({ kind: "wakeup", id, scheduledAt: "2026-11-18T12:00:00.000Z" }, undefined, null, locale)).toEqual(
    projected,
  );
  expect(
    AiQueuedMessageSchema.parse({
      id,
      text: "Check the payment",
      origin: projected,
      state: "failed",
      createdAt: "2026-11-18T12:00:00.000Z",
      authorIsViewer: false,
      error: "dispatch_failed",
      retrying: true,
    }),
  ).toMatchObject({ origin: projected, error: "dispatch_failed", retrying: true });
});
