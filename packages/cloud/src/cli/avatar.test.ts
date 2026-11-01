import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PersonAvatar, RobotAvatar } from "../contracts/avatar";
import account from "./account";
import adminCli from "./admin";
import { applyAvatarParts, readAvatarPhoto } from "./avatar";
import type { CloudCliContext, CloudCliFlags } from "./index";

const person: PersonAvatar = {
  v: 1,
  kind: "person",
  face: "round",
  skin: "s3",
  hair: "short",
  hairColor: "brown",
  eyes: "dots",
  brows: "straight",
  mouth: "smile",
  beard: "none",
  glasses: "none",
  head: "none",
  extra: "none",
  bg: "sky",
};
const robot: RobotAvatar = {
  v: 1,
  kind: "robot",
  head: "square",
  antenna: "ball",
  eyes: "round",
  mouth: "grill",
  body: "light",
  color: "teal",
  bg: "sand",
};
const AGENT_ID = "0b2f5c7e-0000-4000-8000-000000000001";

const context = (args: string[], responses: unknown[], flags: CloudCliFlags = {}) => {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const tables: unknown[][] = [];
  const ctx: CloudCliContext = {
    args,
    flags,
    options: { profile: "test", server: "http://cloud.test", token: "token", output: "text" },
    getDefault: async () => undefined,
    setDefault: async () => undefined,
    createApiClient: (() => {
      throw new Error("not needed");
    }) as CloudCliContext["createApiClient"],
    fetch: async (path, init) => {
      calls.push({ path: String(path), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (responses.length === 0) throw new Error(`Unexpected fetch: ${path}`);
      return Response.json(responses.shift());
    },
    readJson: async (response) => response.json(),
    print: () => undefined,
    write: async () => undefined,
    error: () => undefined,
    json: () => undefined,
    jsonLine: () => undefined,
    table: (rows) => void tables.push(rows),
  };
  return { ctx, calls, tables };
};

describe("avatar parts", () => {
  test("changes named parts and lists the choices for a wrong value", () => {
    expect(applyAvatarParts(person, ["hair=curly", "hairColor=red"])).toMatchObject({ hair: "curly", hairColor: "red", skin: "s3" });
    expect(() => applyAvatarParts(person, ["hair=part"])).toThrow('Unknown hair "part". Choose one of: none, short, buzz, curly');
    expect(() => applyAvatarParts(person, ["hat=crown"])).toThrow('Unknown part "hat"');
    expect(() => applyAvatarParts(person, ["kind=robot"])).toThrow('Unknown part "kind"');
    expect(() => applyAvatarParts(robot, ["hair=short"])).toThrow('Unknown part "hair"');
    expect(() => applyAvatarParts(person, [])).toThrow("at least one part=value");
  });

  test("reads only small PNG, JPEG, or WebP photos", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cld-avatar-"));
    try {
      const png = join(dir, "photo.png");
      await writeFile(png, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]));
      expect(await readAvatarPhoto(png)).toStartWith("data:image/png;base64,");
      const svg = join(dir, "photo.svg");
      await writeFile(svg, "<svg/>");
      await expect(readAvatarPhoto(svg)).rejects.toThrow("PNG, JPEG, or WebP");
      const large = join(dir, "large.jpg");
      await writeFile(large, new Uint8Array([0xff, 0xd8, 0xff, ...new Array(60 * 1024).fill(0)]));
      await expect(readAvatarPhoto(large)).rejects.toThrow("the limit is 48 KiB");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("cld account avatar", () => {
  test("set changes parts of the stored avatar and shows it", async () => {
    const state = { kind: "built", built: person, hasPhoto: false, avatarHash: "h" };
    const f = context(["avatar", "set", "glasses=round"], [state, { ...state, built: { ...person, glasses: "round" } }]);
    await account.run(f.ctx);
    expect(f.calls[1]).toEqual({ path: "/api/me/avatar", method: "PUT", body: { built: { ...person, glasses: "round" } } });
  });

  test("random keeps the skin tone, use maps avatar to built", async () => {
    const state = { kind: "built", built: person, hasPhoto: true, avatarHash: "h" };
    const random = context(["avatar", "random"], [state, state]);
    await account.run(random.ctx);
    expect((random.calls[1]?.body as { built: PersonAvatar }).built.skin).toBe("s3");
    const use = context(["avatar", "use", "avatar"], [state]);
    await account.run(use.ctx);
    expect(use.calls[0]).toEqual({ path: "/api/me/avatar", method: "PUT", body: { use: "built" } });
    await expect(account.run(context(["avatar", "use", "robot"], []).ctx)).rejects.toThrow("Choose photo, avatar, or initials");
  });
});

describe("cld admin agents avatar", () => {
  test("set changes the agent's robot through the administration API", async () => {
    const agent = {
      id: AGENT_ID,
      name: "Festplaner",
      kind: "agent",
      status: "active",
      createdBy: null,
      createdAt: "2026-10-23T00:00:00.000Z",
    };
    const state = { kind: "built", built: robot, hasPhoto: false, avatarHash: "h" };
    const f = context(["agents", "avatar", "set", AGENT_ID, "head=round", "color=coral"], [agent, state, state]);
    await adminCli.run(f.ctx);
    expect(f.calls[2]).toEqual({
      path: `/api/admin/identity/service-accounts/${AGENT_ID}/avatar`,
      method: "PUT",
      body: { built: { ...robot, head: "round", color: "coral" } },
    });
  });
});
