import { afterAll, expect, test } from "bun:test";
import { type PersonAvatar, robotAvatarFromSeed } from "@k2b/cloud/contracts/avatar";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { renderAvatarSvg } from "@k2b/cloud/shared";
import { sql } from "bun";
import { tinyJpeg } from "../../../../scripts/fixtures/image-metadata";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { accountsAppService } from "@k2b/cloud/services";
import users from "./users";

const created: { users: string[]; agents: string[] } = { users: [], agents: [] };
const person: PersonAvatar = {
  v: 1,
  kind: "person",
  face: "round",
  skin: "s6",
  hair: "afro",
  hairColor: "dark",
  eyes: "happy",
  brows: "straight",
  mouth: "grin",
  beard: "goatee",
  glasses: "none",
  head: "none",
  extra: "none",
  bg: "peach",
};

const insertUser = async () => {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile) VALUES (${`delivery-${crypto.randomUUID()}`}, 'local', 'user') RETURNING id`;
  created.users.push(user!.id);
  return user!.id;
};

databaseSuite()("avatar delivery", () => {
  afterAll(async () => {
    for (const id of created.agents) await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
    for (const id of created.users) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
  });

  const fetchAvatar = (cookie: string, id: string, rev?: string, etag?: string) =>
    users.request(`/${id}/avatar${rev ? `?rev=${rev}` : ""}`, { headers: { cookie, ...(etag ? { "if-none-match": etag } : {}) } });

  test("serves only the picture a person shows, with safe headers and cache rules", async () => {
    const viewer = `session_token=${await createTestSession(await insertUser())}`;
    const owner = await insertUser();
    const actor = { userId: owner, roles: [] as string[], uid: "owner" };
    expect((await fetchAvatar(viewer, owner)).status).toBe(404);

    const jpeg = await tinyJpeg();
    const photo = await accountsAppService.user.updateAvatar({
      actor,
      id: owner,
      change: { dataUrl: `data:image/jpeg;base64,${Buffer.from(jpeg).toString("base64")}` },
    });
    if (!photo.ok) throw new Error(photo.error.message);
    const photoResponse = await fetchAvatar(viewer, owner, photo.data.avatarHash ?? "");
    expect(photoResponse.headers.get("content-type")).toBe("image/jpeg");
    expect(photoResponse.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");

    const built = await accountsAppService.user.updateAvatar({ actor, id: owner, change: { built: person } });
    if (!built.ok) throw new Error(built.error.message);
    const hash = built.data.avatarHash ?? "";
    // The old photo URL now gets the built avatar: an inactive photo is never served.
    const stale = await fetchAvatar(viewer, owner, photo.data.avatarHash ?? "");
    expect(stale.headers.get("content-type")).toBe("image/svg+xml");
    expect(stale.headers.get("cache-control")).toBe("private, no-cache");

    const current = await fetchAvatar(viewer, owner, hash);
    expect(current.status).toBe(200);
    expect(current.headers.get("content-type")).toBe("image/svg+xml");
    expect(current.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(current.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    expect(current.headers.get("x-content-type-options")).toBe("nosniff");
    expect(current.headers.get("etag")).toBe(`"${hash}"`);
    expect(await current.text()).toBe(renderAvatarSvg(person));
    expect((await fetchAvatar(viewer, owner, hash, `"${hash}"`)).status).toBe(304);

    const initials = await accountsAppService.user.updateAvatar({ actor, id: owner, change: { use: "initials" } });
    expect(initials.ok && initials.data.avatarHash).toBe(null);
    expect((await fetchAvatar(viewer, owner, hash)).status).toBe(404);
  });

  test("serves every service account's robot without a hash and revalidates it", async () => {
    const viewer = `session_token=${await createTestSession(await insertUser())}`;
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO auth.service_accounts (name, kind) VALUES (${`Delivery agent ${crypto.randomUUID()}`}, 'agent') RETURNING id`;
    created.agents.push(agent!.id);
    const response = await fetchAvatar(viewer, agent!.id);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(await response.text()).toBe(renderAvatarSvg(robotAvatarFromSeed(agent!.id)));
    expect((await fetchAvatar(viewer, agent!.id, undefined, response.headers.get("etag") ?? "")).status).toBe(304);
  });
});
