import { expect, test } from "bun:test";
import { secrets } from "@k2b/cloud/services";
import { hashSharePassword, requireSharePassword, unlockSharePassword } from "./share-password";

test("Argon2id salts equal passwords independently and verifies exact bytes", async () => {
  const first = await hashSharePassword("share secret 123");
  const second = await hashSharePassword("share secret 123");
  expect(first).toStartWith("$argon2id$");
  expect(first).not.toBe(second);
  expect(await Bun.password.verify("share secret 123", first)).toBe(true);
  expect(await Bun.password.verify("share secret 123 ", first)).toBe(false);
});
test("unlock grants are encrypted, share-bound, expiring and invalidated by a changed verifier", async () => {
  const row = { id: "one", password_hash: await hashSharePassword("share secret 123") };
  await expect(requireSharePassword(row)).rejects.toMatchObject({ code: "share_password_required" });
  await expect(unlockSharePassword(row, "wrong")).rejects.toMatchObject({ code: "share_password_invalid" });
  const access = await unlockSharePassword(row, "share secret 123");
  expect(access).not.toContain("share secret");
  await requireSharePassword(row, access);
  await expect(requireSharePassword({ ...row, id: "two" }, access)).rejects.toMatchObject({ code: "share_password_required" });
  await expect(requireSharePassword(row, access + "00")).rejects.toMatchObject({ code: "share_password_required" });
  await expect(requireSharePassword({ ...row, password_hash: await hashSharePassword("share secret 123") }, access)).rejects.toMatchObject({
    code: "share_password_required",
  });
  const grant = await secrets.decrypt<Record<string, unknown>>(access);
  const expired = await secrets.encrypt({ ...grant, expires: 0 });
  await expect(requireSharePassword(row, expired)).rejects.toMatchObject({ code: "share_password_required" });
  await requireSharePassword({ id: "unprotected", password_hash: null });
});
