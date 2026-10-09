import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sql } from "bun";
import { tinyJpeg, withCameraMetadata } from "../../../../../scripts/fixtures/image-metadata";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import "../../../../../scripts/fixtures/authorization-preload";
import meApi from "../../api/me";
import { createTestSession } from "../session/session.test-fixture";
import { getAvatar, setAvatar } from "./avatar";

// No storage access should be attempted for an image that cannot be stripped.
test("malformed avatar container fails with a typed 422 before storing", async () => {
  await expect(setAvatar({ id: crypto.randomUUID(), dataUrl: "data:image/jpeg;base64,/9j/2wA=" })).rejects.toMatchObject({ status: 422 });
});

databaseSuite()("profile image privacy", () => {
  test("new avatars store sanitized bytes and matching hashes; malformed API upload returns 422", async () => {
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile) VALUES (${`photo-${crypto.randomUUID()}`}, 'local', 'user') RETURNING id
    `;
    try {
      const token = await createTestSession(user!.id);
      const jpeg = await tinyJpeg();
      const dataUrl = (bytes: Uint8Array) => `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;
      const put = (bytes: Uint8Array) =>
        meApi.request("/avatar", {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ dataUrl: dataUrl(bytes) }),
        });
      expect((await put(withCameraMetadata(jpeg, 1))).status).toBe(200);
      const stored = await getAvatar({ id: user!.id });
      expect(stored?.bytes).toEqual(Buffer.from(jpeg));
      expect(stored?.hash).toBe(createHash("sha256").update(dataUrl(jpeg)).digest("hex"));
      expect((await put(new Uint8Array([255, 216, 255, 219, 0]))).status).toBe(422);
      expect((await getAvatar({ id: user!.id }))?.hash).toBe(stored?.hash);
    } finally {
      await sql`DELETE FROM auth.users WHERE id=${user!.id}::uuid`;
    }
  });
});
