import { expect, test } from "bun:test";
import { assertPersonalChatWriter } from "./chat-writer";

const owner = "00000000-0000-4000-8000-000000000001";

test("personal Code uses the owning person's subject independently of its automation actor", () => {
  expect(assertPersonalChatWriter({ type: "user", userId: owner, delegatedByServiceAccountId: "code-runner" }, owner)).toBe(owner);
});

test("mailbox Code cannot write a personal chat with its service-account subject", () => {
  expect(() => assertPersonalChatWriter({ type: "service_account", serviceAccountId: owner }, owner)).toThrow("owning person's");
});

test("another person's subject and an ownerless target are refused", () => {
  expect(() => assertPersonalChatWriter({ type: "user", userId: "another-person" }, owner)).toThrow();
  expect(() => assertPersonalChatWriter({ type: "user", userId: owner }, null)).toThrow();
});
