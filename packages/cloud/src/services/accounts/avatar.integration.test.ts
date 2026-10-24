import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sql } from "bun";
import { tinyJpeg, withCameraMetadata } from "../../../../../scripts/fixtures/image-metadata";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import "../../../../../scripts/fixtures/authorization-preload";
import { createAdminIdentityRoutes } from "../../api/admin-identity";
import meApi from "../../api/me";
import { type PersonAvatar, type RobotAvatar, robotAvatarFromSeed } from "../../contracts/avatar";
import { renderAvatarSvg } from "../../shared/avatar-art";
import { createTestSession } from "../session/session.test-fixture";
import { builtAvatarHash, getAvatar, refreshBuiltAvatarHashes, setAvatar, updateAvatar, writeRefreshedHash } from "./avatar";

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

const person: PersonAvatar = {
  v: 1,
  kind: "person",
  face: "oval",
  skin: "s4",
  hair: "curly",
  hairColor: "black",
  eyes: "ovals",
  brows: "arched",
  mouth: "smile",
  beard: "none",
  glasses: "round",
  head: "none",
  extra: "none",
  bg: "mint",
};
const robot: RobotAvatar = {
  v: 1,
  kind: "robot",
  head: "capsule",
  antenna: "dish",
  eyes: "visor",
  mouth: "led",
  body: "panel",
  color: "coral",
  bg: "sky",
};

const insertUser = async (admin = false) => {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, admin) VALUES (${`avatar-${crypto.randomUUID()}`}, 'local', 'user', ${admin}) RETURNING id
  `;
  return user!.id;
};
const insertAgent = async (kind: "agent" | "standalone" = "agent") => {
  const [account] = await sql<{ id: string }[]>`
    INSERT INTO auth.service_accounts (name, kind) VALUES (${`Avatar agent ${crypto.randomUUID()}`}, ${kind}) RETURNING id
  `;
  return account!.id;
};

databaseSuite()("built avatars", () => {
  const meRequest = (token: string, method: string, body?: unknown) =>
    meApi.request("/avatar", {
      method,
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  test("a person switches between photo, built avatar, and initials; only the shown picture is served", async () => {
    const id = await insertUser();
    try {
      const token = await createTestSession(id);
      expect(await (await meRequest(token, "GET")).json()).toEqual({
        kind: "initials",
        built: null,
        hasPhoto: false,
        photo: null,
        avatarHash: null,
      });
      expect(await getAvatar({ id })).toBeNull();
      expect((await meRequest(token, "PUT", { use: "photo" })).status).toBe(409);

      const jpeg = await tinyJpeg();
      const photoUrl = `data:image/jpeg;base64,${Buffer.from(jpeg).toString("base64")}`;
      expect((await meRequest(token, "PUT", { dataUrl: photoUrl })).status).toBe(200);
      const photoHash = (await getAvatar({ id }))?.hash;

      const saved = await meRequest(token, "PUT", { built: person });
      expect(saved.status).toBe(200);
      const state = (await saved.json()) as { kind: string; built: PersonAvatar; hasPhoto: boolean; avatarHash: string };
      expect(state).toMatchObject({ kind: "built", built: person, hasPhoto: true, message: "Avatar updated." });
      expect(state.avatarHash).toBe(builtAvatarHash(person));
      const served = await getAvatar({ id });
      expect(served?.contentType).toBe("image/svg+xml");
      expect(served?.bytes.toString()).toBe(renderAvatarSvg(person));
      const [column] = await sql<{ avatar_hash: string }[]>`SELECT avatar_hash FROM auth.users WHERE id = ${id}::uuid`;
      expect(column?.avatar_hash).toBe(state.avatarHash);

      // The inactive photo stays stored and comes back without a new upload.
      expect((await (await meRequest(token, "PUT", { use: "photo" })).json()) as object).toMatchObject({ kind: "photo", hasPhoto: true });
      // The owner reads the stored photo back, also while it is not the active picture.
      expect(((await (await meRequest(token, "PUT", { use: "built" })).json()) as { photo: string }).photo).toStartWith(
        "data:image/jpeg;base64,",
      );
      expect((await (await meRequest(token, "PUT", { use: "photo" })).json()) as object).toMatchObject({ kind: "photo" });
      expect((await getAvatar({ id }))?.hash).toBe(photoHash);

      // Deleting the shown photo shows initials; the built avatar stays stored.
      expect((await meRequest(token, "DELETE")).status).toBe(200);
      expect(await (await meRequest(token, "GET")).json()).toEqual({
        kind: "initials",
        built: person,
        hasPhoto: false,
        photo: null,
        avatarHash: null,
      });
      expect(await getAvatar({ id })).toBeNull();
      expect((await (await meRequest(token, "PUT", { use: "built" })).json()) as object).toMatchObject({ kind: "built" });
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
    }
  });

  test("a person cannot store a robot, an unknown part, or an oversized config", async () => {
    const id = await insertUser();
    try {
      const token = await createTestSession(id);
      expect((await meRequest(token, "PUT", { built: robot })).status).toBe(400);
      expect((await meRequest(token, "PUT", { built: { ...person, hair: "part" } })).status).toBe(400);
      expect((await meRequest(token, "PUT", { built: { ...person, note: "x".repeat(2_000) } })).status).toBe(400);
      expect((await meRequest(token, "PUT", { use: "built" })).status).toBe(409);
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
    }
  });

  test("the database rejects a shown built avatar without its config", async () => {
    const id = await insertUser();
    try {
      const attempt = async (write: () => Promise<unknown>) => {
        try {
          await write();
          return "stored";
        } catch (error) {
          return (error as { constraint?: string }).constraint;
        }
      };
      expect(
        await attempt(() => sql`UPDATE auth.users SET avatar_kind = 'built', avatar_hash = ${"a".repeat(64)} WHERE id = ${id}::uuid`),
      ).toBe("users_avatar_state_check");
      expect(
        await attempt(() => sql`UPDATE auth.users SET avatar_kind = 'initials', avatar_hash = ${"a".repeat(64)} WHERE id = ${id}::uuid`),
      ).toBe("users_avatar_state_check");
      expect(await attempt(() => sql`UPDATE auth.service_accounts SET avatar_kind = 'photo' WHERE id = ${crypto.randomUUID()}::uuid`)).toBe(
        "stored",
      );
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
    }
  });

  test("every service account shows its robot, drawn from its id, until an administrator changes it", async () => {
    const agent = await insertAgent();
    const adminId = await insertUser(true);
    const userId = await insertUser();
    try {
      const expected = robotAvatarFromSeed(agent);
      const served = await getAvatar({ id: agent });
      expect(served?.contentType).toBe("image/svg+xml");
      expect(served?.bytes.toString()).toBe(renderAvatarSvg(expected));
      expect(served?.hash).toBe(builtAvatarHash(expected));
      expect((await getAvatar({ id: agent }))?.hash).toBe(served?.hash);

      const routes = createAdminIdentityRoutes();
      const call = (token: string, method: string, body?: unknown) =>
        routes.request(`/service-accounts/${agent}/avatar`, {
          method,
          headers: { cookie: `session_token=${token}`, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      const admin = await createTestSession(adminId);
      const someone = await createTestSession(userId);
      expect((await call(someone, "GET")).status).toBe(403);
      expect((await call(someone, "PUT", { built: robot })).status).toBe(403);

      expect(await (await call(admin, "GET")).json()).toMatchObject({ kind: "built", built: expected, hasPhoto: false });
      expect((await call(admin, "PUT", { built: person })).status).toBe(400);
      expect((await call(admin, "PUT", { use: "photo" })).status).toBe(409);
      expect((await call(admin, "PUT", { built: robot })).status).toBe(200);
      expect((await getAvatar({ id: agent }))?.bytes.toString()).toBe(renderAvatarSvg(robot));

      const jpeg = await tinyJpeg();
      const photoUrl = `data:image/jpeg;base64,${Buffer.from(jpeg).toString("base64")}`;
      expect(await (await call(admin, "PUT", { dataUrl: photoUrl })).json()).toMatchObject({ kind: "photo", hasPhoto: true });
      expect((await getAvatar({ id: agent }))?.contentType).toBe("image/jpeg");
      expect(await (await call(admin, "DELETE")).json()).toMatchObject({ kind: "built", built: robot, hasPhoto: false });
      expect((await getAvatar({ id: agent }))?.bytes.toString()).toBe(renderAvatarSvg(robot));
    } finally {
      await sql`DELETE FROM auth.service_accounts WHERE id = ${agent}::uuid`;
      await sql`DELETE FROM auth.users WHERE id IN (${adminId}::uuid, ${userId}::uuid)`;
    }
  });

  test("a refresh never overwrites a save that happened after it read the row", async () => {
    const id = await insertUser();
    try {
      await sql`UPDATE auth.users SET avatar_kind = 'built', avatar_config = ${JSON.stringify(person)}::text::jsonb, avatar_hash = ${"b".repeat(64)} WHERE id = ${id}::uuid`;
      const [stale] = await sql<{ id: string; avatar_config: unknown; avatar_hash: string | null }[]>`
        SELECT id, avatar_config, avatar_hash FROM auth.users WHERE id = ${id}::uuid`;
      const saved = await updateAvatar({ id, change: { built: { ...person, hair: "afro" } } });
      expect(saved.ok).toBe(true);
      expect(await writeRefreshedHash(sql, "users", stale!)).toBe(false);
      const [row] = await sql<{ avatar_hash: string }[]>`SELECT avatar_hash FROM auth.users WHERE id = ${id}::uuid`;
      expect(row?.avatar_hash).toBe(builtAvatarHash({ ...person, hair: "afro" }));
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
    }
  });

  test("serves the hash of the renderer that draws the bytes, whatever is stored", async () => {
    const id = await insertUser();
    try {
      // Another replica with a newer renderer already stored its hash for this config.
      await sql`UPDATE auth.users SET avatar_kind = 'built', avatar_config = ${JSON.stringify(person)}::text::jsonb, avatar_hash = ${"d".repeat(64)} WHERE id = ${id}::uuid`;
      expect((await getAvatar({ id }))?.hash).toBe(builtAvatarHash(person));
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
    }
  });

  test("every spelling of an account id draws the same robot", async () => {
    const agent = await insertAgent();
    try {
      const lower = await getAvatar({ id: agent });
      const upper = await getAvatar({ id: agent.toUpperCase() });
      expect(upper?.hash).toBe(lower?.hash);
      expect(upper?.bytes.toString()).toBe(lower?.bytes.toString());
    } finally {
      await sql`DELETE FROM auth.service_accounts WHERE id = ${agent}::uuid`;
    }
  });

  test("a stale built hash is refreshed at startup", async () => {
    const id = await insertUser();
    try {
      await sql`UPDATE auth.users SET avatar_kind = 'built', avatar_config = ${JSON.stringify(person)}::text::jsonb, avatar_hash = ${"b".repeat(64)} WHERE id = ${id}::uuid`;
      expect(await refreshBuiltAvatarHashes()).toBeGreaterThanOrEqual(1);
      const [row] = await sql<{ avatar_hash: string }[]>`SELECT avatar_hash FROM auth.users WHERE id = ${id}::uuid`;
      expect(row?.avatar_hash).toBe(builtAvatarHash(person));
      expect(await refreshBuiltAvatarHashes()).toBe(0);
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
    }
  });
});
