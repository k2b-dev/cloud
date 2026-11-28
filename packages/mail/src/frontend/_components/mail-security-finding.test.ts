import { expect, test } from "bun:test";
import { forwardLeavesAttachmentsOut } from "./mail-security-finding";

const attachment = { id: "Att1" };
const restricted = { attachments: [attachment], security: { linksDisabled: true } };

test("a forward of a message whose links a policy turns off goes without its attachments", () => {
  expect(forwardLeavesAttachmentsOut("forward", restricted)).toBe(true);
});

test("a reply, a clear message or one without attachments says nothing", () => {
  expect(forwardLeavesAttachmentsOut("reply", restricted)).toBe(false);
  expect(forwardLeavesAttachmentsOut("forward", { attachments: [attachment], security: { linksDisabled: false } })).toBe(false);
  expect(forwardLeavesAttachmentsOut("forward", { attachments: [attachment] })).toBe(false);
  expect(forwardLeavesAttachmentsOut("forward", { attachments: [], security: { linksDisabled: true } })).toBe(false);
  expect(forwardLeavesAttachmentsOut("forward", null)).toBe(false);
});
