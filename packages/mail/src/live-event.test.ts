import { expect, test } from "bun:test";
import { parseMailLiveEvent } from "./live-event";
import { MailLiveEventSchema } from "./live-events";

const inherited = Object.create({ conversationId: "AbCd12" });
const extraInherited = Object.create({ extra: true });
extraInherited.conversationId = null;
const nonEnumerable = Object.defineProperty({}, "conversationId", { value: "AbCd12" });
const symbolKey = { conversationId: null, [Symbol("ignored")]: true };

test.each(
  [
    null,
    undefined,
    false,
    0,
    "AbCd12",
    [],
    ["AbCd12"],
    {},
    new Date(),
    new Map(),
    new Set(),
    { conversationId: null },
    { conversationId: "AbCd12" },
    { conversationId: "000000" },
    { conversationId: undefined },
    { conversationId: 123456 },
    { conversationId: "" },
    { conversationId: "abcde" },
    { conversationId: "abcdefg" },
    { conversationId: "AbCd1!" },
    { conversationId: "éabc12" },
    { conversationId: " abc12" },
    { conversationId: "AbCd12\n" },
    { conversationId: null, extra: true },
    { conversationId: "AbCd12", extra: undefined },
    inherited,
    extraInherited,
    nonEnumerable,
    symbolKey,
  ].map((value) => [value]),
)("live parsing agrees with the strict server schema for %#", (value: unknown) => {
  const parsed = MailLiveEventSchema.safeParse(value);
  if (!parsed.success) {
    expect(() => parseMailLiveEvent(value)).toThrow();
    return;
  }
  const actual = parseMailLiveEvent(value);
  expect(actual).toEqual(parsed.data);
  expect(actual).not.toBe(value);
});
