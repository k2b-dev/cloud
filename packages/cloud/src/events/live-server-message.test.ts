import { expect, test } from "bun:test";
import type { z } from "zod";
import { LiveServerMessageSchema } from "./live-protocol";
import { type LiveServerMessage, parseLiveServerMessage } from "./live-server-message";

const messages: LiveServerMessage[] = [
  { t: "ready", id: "a", cursor: "s1" },
  { t: "event", id: "a", cursor: "s2", data: { nested: [1, null] } },
  { t: "event", id: "", cursor: "", data: undefined },
  { t: "event", id: "a", cursor: "s2", data: null },
  { t: "progress", cursor: "s2" },
  { t: "resync", id: "a", cursor: "s3" },
  { t: "revoked", id: "a", code: "not_found" },
  { t: "revoked", id: "a", code: "access_denied" },
  { t: "error", code: "unavailable", message: "Try again" },
  { t: "error", code: "", message: "" },
];
const bodies: [string, unknown][] = [
  ["unknown kind", { t: "unknown" }],
  ["wrong revoked code", { t: "revoked", id: "a", code: "unavailable" }],
  ["inherited fields", Object.create({ t: "event", id: "a", cursor: "s1", data: undefined })],
  ["missing kind", {}],
  ["null", null],
  ["undefined", undefined],
  ["array", []],
  ["string", "ready"],
  ["number", 1],
  ["boolean", true],
];
for (const message of messages) {
  bodies.push([`${message.t}: valid`, message], [`${message.t}: extra keys`, { ...message, extra: "strip me" }]);
  for (const key of Object.keys(message)) {
    bodies.push([`${message.t}: missing ${key}`, Object.fromEntries(Object.entries(message).filter(([field]) => field !== key))]);
    if (key !== "data") {
      for (const value of [0, null, undefined, {}, [], true]) {
        bodies.push([`${message.t}: wrong ${key} (${JSON.stringify(value)})`, { ...message, [key]: value }]);
      }
    }
  }
}

test.each(bodies)("live server messages match the schema: %s", (_name, body) => {
  const expected = LiveServerMessageSchema.safeParse(body);
  const actual = parseLiveServerMessage(body);
  // Assignment in both directions keeps the validator-free union equal to the inferred schema type.
  const inferred: z.infer<typeof LiveServerMessageSchema> | null = actual;
  const message: LiveServerMessage | null = expected.success ? expected.data : null;
  expect(actual !== null).toBe(expected.success);
  expect(inferred).toStrictEqual(message);
  if (actual) expect(actual).not.toBe(body);
});
