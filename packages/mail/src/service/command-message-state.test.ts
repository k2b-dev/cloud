import { expect, test } from "bun:test";
import type { RemoteMessagePrecondition } from "../contracts";
import { mailMessageStatePayloadTransitions, projectMailMessagePrecondition } from "./command-message-state";

test("converts confirmed state payloads in provider operation order", () => {
  expect(
    mailMessageStatePayloadTransitions({
      addFlags: ["seen", "answered"],
      removeFlags: ["flagged"],
      addKeywords: ["alpha", "beta"],
      removeKeywords: ["review"],
    }),
  ).toEqual([
    { field: "flags", add: true, value: "seen" },
    { field: "flags", add: true, value: "answered" },
    { field: "flags", add: false, value: "flagged" },
    { field: "keywords", add: true, value: "alpha" },
    { field: "keywords", add: true, value: "beta" },
    { field: "keywords", add: false, value: "review" },
  ]);
});

test("retains modseq without sibling writes and drops it only when a transition applies", () => {
  const frozen: RemoteMessagePrecondition = { modseq: "42", flags: [], keywords: [] };
  expect(
    projectMailMessagePrecondition(
      frozen,
      mailMessageStatePayloadTransitions({
        addFlags: [],
        removeFlags: [],
        addKeywords: [],
        removeKeywords: [],
      }),
    ),
  ).toBe(frozen);
  expect(
    projectMailMessagePrecondition(
      frozen,
      mailMessageStatePayloadTransitions({
        addFlags: ["seen"],
        removeFlags: [],
        addKeywords: ["alpha"],
        removeKeywords: [],
      }),
    ),
  ).toEqual({ modseq: undefined, flags: ["seen"], keywords: ["alpha"] });
  expect(frozen).toEqual({ modseq: "42", flags: [], keywords: [] });
});
