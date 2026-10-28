import { describe, expect, test } from "bun:test";
import { cloudAvatarImage } from "./Avatar";

const ID = "0b2f5c7e-0000-4000-8000-000000000001";

describe("cloudAvatarImage", () => {
  test("links a person's picture only with a hash", () => {
    expect(cloudAvatarImage({ kind: "user", userId: ID, avatarHash: "abc" })).toBe(`/api/accounts/users/${ID}/avatar?rev=abc`);
    expect(cloudAvatarImage({ kind: "user", userId: ID, avatarHash: null })).toBeUndefined();
  });

  test("always links a service account's robot or photo, revalidating without a hash", () => {
    expect(cloudAvatarImage({ kind: "service_account", userId: ID })).toBe(`/api/accounts/users/${ID}/avatar`);
    expect(cloudAvatarImage({ kind: "service_account", userId: ID, avatarHash: "abc" })).toBe(`/api/accounts/users/${ID}/avatar?rev=abc`);
    expect(cloudAvatarImage({ kind: "system", userId: ID })).toBeUndefined();
  });
});
