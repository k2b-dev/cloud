import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { newShortId } from "../lib/short-id";
import { resolvePublicId, resolvePublicIds } from "./public-resources";

describe("Spaces public resource boundary", () => {
  test("rejects legacy UUID selectors before database resolution", async () => {
    const uuid = crypto.randomUUID();
    expect(await resolvePublicId("spaces", uuid)).toBeNull();
    expect(await resolvePublicIds("items", [uuid])).toBeNull();
  });

  test("accepts only exact six-character public selectors", async () => {
    expect(await resolvePublicId("spaces", "abc12")).toBeNull();
    expect(await resolvePublicId("spaces", "abc1234")).toBeNull();
    expect(await resolvePublicId("spaces", "abc-12")).toBeNull();
    expect(await resolvePublicIds("items", ["AbC123", "legacy1"])).toBeNull();
  });

  (process.env.CLOUD_DATABASE_TEST === "1" ? test : test.skip)("preserves duplicate selectors and their input order", async () => {
    const first = { id: crypto.randomUUID(), shortId: newShortId() };
    const second = { id: crypto.randomUUID(), shortId: newShortId() };
    try {
      await sql`
        INSERT INTO spaces.spaces (id, short_id, name)
        VALUES (${first.id}::uuid, ${first.shortId}, 'Public ID test A'), (${second.id}::uuid, ${second.shortId}, 'Public ID test B')
      `;

      expect(await resolvePublicIds("spaces", [first.shortId, first.shortId, second.shortId])).toEqual([first.id, first.id, second.id]);
    } finally {
      await sql`DELETE FROM spaces.spaces WHERE id IN (${first.id}::uuid, ${second.id}::uuid)`;
    }
  });
});
