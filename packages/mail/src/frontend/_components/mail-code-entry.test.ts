import { expect, test } from "bun:test";
import { mailCodeEntry } from "./mail-code-entry";

test("the Code entry: administrators always, others when Core lets them see it; the dot only from Core's answer", () => {
  // Core down: the administrator's entry stays, without a dot; nobody else gets one.
  expect(mailCodeEntry({ mailboxAdmin: true, attention: null, active: false })).toEqual({ active: false });
  expect(mailCodeEntry({ mailboxAdmin: false, attention: null, active: false })).toBeUndefined();
  expect(mailCodeEntry({ mailboxAdmin: false, attention: { visible: false, attention: false }, active: false })).toBeUndefined();
  expect(mailCodeEntry({ mailboxAdmin: false, attention: { visible: true, attention: false }, active: false })).toEqual({ active: false });
  expect(mailCodeEntry({ mailboxAdmin: true, attention: { visible: true, attention: true }, active: true })).toEqual({
    active: true,
    attention: true,
  });
});
