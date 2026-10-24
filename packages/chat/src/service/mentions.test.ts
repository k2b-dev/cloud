import { expect, test } from "bun:test";
import { MAX_MENTIONS, MentionCandidateQuerySchema, MentionCandidatesSchema, MentionSchema, SendMessageSchema } from "./contracts";

const id = "11111111-1111-4111-8111-111111111111";
const send = (body: string, mentions: unknown[]) => SendMessageSchema.safeParse({ clientId: "mention", body, mentions });
test("mention offsets preserve the original UTF-16 body, including emoji and repeated people", () => {
  const body = " 😀 Mara, Mara ";
  const mentions = [
    { start: 4, end: 8, principal: { type: "user", id } },
    { start: 10, end: 14, principal: { type: "user", id } },
  ];
  expect(send(body, mentions)).toMatchObject({ success: true, data: { body, mentions } });
  expect(
    send("MaraLena", [
      { start: 4, end: 8, principal: { type: "user", id } },
      { start: 0, end: 4, principal: { type: "user", id } },
    ]).success,
  ).toBeTrue();
});
test("rejects overlaps, empty ranges, outside-body offsets, surrogate splits and invalid principals", () => {
  for (const [body, mentions] of [
    ["Mara", [{ start: -1, end: 3, principal: { type: "user", id } }]],
    ["Mara", [{ start: 0, end: 5, principal: { type: "user", id } }]],
    ["Mara", [{ start: 2, end: 2, principal: { type: "user", id } }]],
    ["Mara", [{ start: 1.5, end: 3, principal: { type: "user", id } }]],
    [
      "Mara",
      [
        { start: 0, end: 3, principal: { type: "user", id } },
        { start: 2, end: 4, principal: { type: "user", id } },
      ],
    ],
    ["😀Mara", [{ start: 1, end: 6, principal: { type: "user", id } }]],
    ["Mara😀", [{ start: 0, end: 5, principal: { type: "user", id } }]],
    [" Mara", [{ start: 0, end: 1, principal: { type: "user", id } }]],
    ["Mara", [{ start: 0, end: 4, principal: { type: "user", id: "bad" } }]],
    ["", [{ start: 0, end: 1, principal: { type: "user", id } }]],
  ] as const)
    expect(send(body, [...mentions]).success).toBeFalse();
});
test("bounds mention count and search input", () => {
  const mentions = Array.from({ length: MAX_MENTIONS }, (_, start) => ({ start, end: start + 1, principal: { type: "user", id } }));
  expect(send("a".repeat(MAX_MENTIONS), mentions).success).toBeTrue();
  expect(send("a".repeat(MAX_MENTIONS + 1), [...mentions, { start: 20, end: 21, principal: { type: "user", id } }]).success).toBeFalse();
  expect(MentionCandidateQuerySchema.parse({})).toEqual({ q: "", thread: "general" });
  expect(MentionCandidateQuerySchema.safeParse({ q: "x".repeat(101) }).success).toBeFalse();
  expect(MentionCandidateQuerySchema.safeParse({ thread: "all" }).success).toBeFalse();
});

test("mentions identify typed principals, and candidates never require a grant", () => {
  for (const type of ["user", "service_account"] as const) {
    const principal = { type, id };
    expect(send("Mara", [{ start: 0, end: 4, principal }]).success).toBeTrue();
    expect(MentionCandidatesSchema.parse({ items: [{ principal, name: "Mara", agent: type === "service_account" }] })).toEqual({
      items: [{ principal, name: "Mara", agent: type === "service_account" }],
    });
  }
  for (const principal of [{ type: "group", id }, { type: "user", id: "bad" }, { type: "user", userId: id }, { id }])
    expect(send("Mara", [{ start: 0, end: 4, principal }]).success).toBeFalse();
  expect(send("Mara", [{ start: 0, end: 4, accessId: id }]).success).toBeFalse();
  expect(MentionSchema.safeParse({ start: 0, end: 4, principal: { type: "user", id }, accessId: id }).success).toBeFalse();
  expect(MentionCandidatesSchema.safeParse({ items: [{ accessId: id, type: "user", name: "Mara", agent: false }] }).success).toBeFalse();
});
