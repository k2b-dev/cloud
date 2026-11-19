import { expect, test } from "bun:test";
import { AiChatOriginSchema } from "./chat-origin";
import { projectAiMessageOrigin, readerResourceName } from "./message-origin";

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
