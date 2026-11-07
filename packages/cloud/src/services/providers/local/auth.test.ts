import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { suiteFor } from "../../../../../../scripts/fixtures/test-infra";
import { redis } from "../../../runtime/clients";
import {
  consumeMagicLinkToken,
  consumePasswordResetToken,
  createAccountLoginToken,
  createMagicLinkToken,
  createPasswordResetToken,
} from "./auth";

const suite = suiteFor("valkey");

suite("local auth password reset tokens", () => {
  test("consumes password reset tokens only once", async () => {
    const payload = {
      userId: crypto.randomUUID(),
      uid: `reset-${crypto.randomUUID()}`,
      email: `reset-${crypto.randomUUID()}@example.test`,
    };
    const token = await createPasswordResetToken({
      ...payload,
      ttlSeconds: 30,
    });

    await assertHashedKey("password-reset:", token);
    expect(await consumePasswordResetToken(token)).toEqual(payload);
    expect(await consumePasswordResetToken(token)).toBeNull();
  });
});

const assertHashedKey = async (prefix: string, token: string) => {
  expect(await redis.get(`${prefix}${token}`)).toBeNull();
  const key = `${prefix}${createHash("sha256").update(token).digest("hex")}`;
  expect(await redis.exists(key)).toBe(true);
  expect(await redis.ttl(key)).toBeGreaterThan(0);
  expect(await redis.ttl(key)).toBeLessThanOrEqual(30);
};

suite("local sign-in token storage", () => {
  test("email and account links use hashed keys and remain single-use", async () => {
    const email = { email: "login@example.test", category: "login" as const };
    const account = { userId: "fixture-account" };
    for (const [payload, token] of [
      [email, await createMagicLinkToken({ ...email, ttlSeconds: 30 })],
      [account, await createAccountLoginToken({ ...account, ttlSeconds: 30 })],
    ] as const) {
      await assertHashedKey("email-login:", token);
      expect(await consumeMagicLinkToken(token)).toEqual(payload);
      expect(await consumeMagicLinkToken(token)).toBeNull();
    }
  });
  test("legacy raw-key tokens are not accepted", async () => {
    const token = "fixture-legacy-token";
    const key = `email-login:${token}`;
    try {
      await redis.set(key, JSON.stringify({ userId: "fixture" }), "EX", 30);
      expect(await consumeMagicLinkToken(token)).toBeNull();
    } finally {
      await redis.del(key);
    }
  });
});
