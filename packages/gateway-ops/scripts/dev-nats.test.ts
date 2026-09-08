import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nkeys } from "@nats-io/transport-node";
import { prepareDevNats } from "./dev-nats";

test("dev NATS preserves its private user seed and global application account", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloud-dev-nats-"));
  try {
    await prepareDevNats(directory);
    const seed = await readFile(`${directory}/admin.seed`);
    const key = nkeys.fromSeed(seed);
    try {
      const config = await readFile(`${directory}/system.conf`, "utf8");
      expect(config).toContain(key.getPublicKey());
      expect(config).not.toContain(seed.toString());
      expect(config).toContain("no_auth_user: dev");
      expect(config).toContain("authorization { users: [{ user: dev }] }");
      expect(config).toContain('system_account: "$SYS"');
      expect(config).toContain('accounts { "$SYS" {');
      await chmod(`${directory}/admin.seed`, 0o644);
      await prepareDevNats(directory);
      expect(await readFile(`${directory}/admin.seed`)).toEqual(seed);
      expect((await stat(`${directory}/admin.seed`)).mode & 0o777).toBe(0o600);
      expect(await readFile(`${directory}/system.conf`, "utf8")).toBe(config);
    } finally {
      key.clear();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dev NATS refuses an invalid existing seed instead of rotating credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloud-dev-nats-"));
  try {
    await writeFile(`${directory}/admin.seed`, "invalid");
    await expect(prepareDevNats(directory)).rejects.toThrow();
    expect(await readFile(`${directory}/admin.seed`, "utf8")).toBe("invalid");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
