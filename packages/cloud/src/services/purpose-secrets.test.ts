import { expect, test } from "bun:test";
import { purposeSecretCipher } from "./purpose-secrets";

test("purpose encryption separates both purpose and owning row and never repeats its nonce", () => {
  const cipher = purposeSecretCipher("cloud.code.secret.v1", { current: "test-only-root" });
  const one = cipher.encrypt("private credential", '["c_one","API"]');
  expect(one).not.toContain("private credential");
  expect(cipher.decrypt(one, '["c_one","API"]')).toBe("private credential");
  expect(cipher.encrypt("private credential", '["c_one","API"]')).not.toBe(one);
  expect(() => cipher.decrypt(one, '["c_other","API"]')).toThrow("secret_unreadable");
  expect(() => purposeSecretCipher("other.purpose", { current: "test-only-root" }).decrypt(one, '["c_one","API"]')).toThrow(
    "secret_unreadable",
  );
  expect(() => cipher.decrypt(one + "00", '["c_one","API"]')).toThrow("secret_unreadable");
});
test("root rotation reads old with previous, rewrites with current, and retires the old root", () => {
  const context = '["c_code","API"]';
  const oldCipher = purposeSecretCipher("cloud.code.secret.v1", { current: "old-test-root" });
  const encrypted = oldCipher.encrypt("private credential", context);
  const rotating = purposeSecretCipher("cloud.code.secret.v1", { current: "new-test-root", previous: "old-test-root" });
  const rewritten = rotating.encrypt(rotating.decrypt(encrypted, context), context);
  const current = purposeSecretCipher("cloud.code.secret.v1", { current: "new-test-root" });
  expect(current.decrypt(rewritten, context)).toBe("private credential");
  expect(() => current.decrypt(encrypted, context)).toThrow("secret_unreadable");
  expect(() => oldCipher.decrypt(rewritten, context)).toThrow("secret_unreadable");
});
