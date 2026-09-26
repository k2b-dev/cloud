import { expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { MAX_ITEM_LINKS } from "../contracts";
import { newShortId } from "../lib/short-id";
import * as links from "./item-links";
import * as spaces from "./spaces";

const suite = databaseSuite();

suite("Spaces item links", () => {
  test("stores bounded external links per item and the Space's GitHub token encrypted", async () => {
    const [space] = await sql<
      { id: string }[]
    >`INSERT INTO spaces.spaces (short_id, name) VALUES (${newShortId()}, 'Links test') RETURNING id`;
    const spaceId = space!.id;
    try {
      const [column] = await sql<{ id: string }[]>`INSERT INTO spaces.columns (short_id, space_id, name, rank, is_done)
        VALUES (${newShortId()}, ${spaceId}::uuid, 'Open', 1024, false) RETURNING id`;
      const [item] = await sql<{ id: string }[]>`INSERT INTO spaces.items (short_id, space_id, column_id, title)
        VALUES (${newShortId()}, ${spaceId}::uuid, ${column!.id}::uuid, 'Serve cld plugins') RETURNING id`;
      const itemId = item!.id;

      const issue = "https://github.com/k2b-dev/cloud/issues/263";
      expect(await links.add({ itemId, spaceId, link: { url: issue } })).toMatchObject({ url: issue, label: null });
      // Re-adding the same URL updates the label instead of duplicating the link.
      expect(await links.add({ itemId, spaceId, link: { url: issue, label: "Issue" } })).toMatchObject({ url: issue, label: "Issue" });
      expect(await links.add({ itemId, spaceId, link: { url: "https://example.org/spec", label: "  " } })).toMatchObject({ label: null });
      expect((await links.list({ itemId })).map((link) => link.url)).toEqual([issue, "https://example.org/spec"]);

      for (let index = 2; index < MAX_ITEM_LINKS; index += 1)
        expect(await links.add({ itemId, spaceId, link: { url: `https://example.org/${index}` } })).not.toBeNull();
      expect(await links.add({ itemId, spaceId, link: { url: "https://example.org/one-too-many" } })).toBeNull();
      // An existing link still accepts a label change at the limit.
      expect(await links.add({ itemId, spaceId, link: { url: issue, label: "Tracked" } })).toMatchObject({ label: "Tracked" });
      expect(await links.list({ itemId })).toHaveLength(MAX_ITEM_LINKS);

      expect(await links.remove({ itemId, spaceId, url: "https://example.org/spec" })).toBeTrue();
      expect(await links.remove({ itemId, spaceId, url: "https://example.org/spec" })).toBeFalse();
      // Bun's lazy query object is not a Promise; a real promise carries the CHECK violation to `rejects`.
      const tooLong = `https://${"x".repeat(600)}`;
      const rejected = await sql`INSERT INTO spaces.item_links (item_id, url) VALUES (${itemId}::uuid, ${tooLong})`.then(
        () => null,
        (error: unknown) => error,
      );
      expect(rejected).toBeInstanceOf(Error);

      // The token round-trips through the platform cipher and never sits in clear text.
      expect(await spaces.hasGitHubToken({ id: spaceId })).toBeFalse();
      expect(await spaces.getGitHubToken({ id: spaceId })).toBeNull();
      expect(await spaces.setGitHubToken({ id: spaceId, token: "ghp_secret_value" })).toEqual({ ok: true, data: { configured: true } });
      const [row] = await sql<
        { github_token_encrypted: string }[]
      >`SELECT github_token_encrypted FROM spaces.spaces WHERE id = ${spaceId}::uuid`;
      expect(row!.github_token_encrypted).not.toContain("ghp_secret_value");
      expect(await spaces.hasGitHubToken({ id: spaceId })).toBeTrue();
      expect(await spaces.getGitHubToken({ id: spaceId })).toBe("ghp_secret_value");
      expect(await spaces.setGitHubToken({ id: spaceId, token: null })).toEqual({ ok: true, data: { configured: false } });
      expect(await spaces.getGitHubToken({ id: spaceId })).toBeNull();
      expect(await spaces.setGitHubToken({ id: crypto.randomUUID(), token: "x" })).toMatchObject({ ok: false, status: 404 });

      // Links disappear with their item.
      await sql`DELETE FROM spaces.items WHERE id = ${itemId}::uuid`;
      expect(await links.list({ itemId })).toEqual([]);
    } finally {
      await sql`DELETE FROM spaces.spaces WHERE id = ${spaceId}::uuid`;
    }
  });
});
