import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credsAuthenticator, nkeys } from "@nats-io/transport-node";
import { prepareDevNats } from "./dev-nats";

test("dev NATS preserves its private user seeds and keeps applications in DEV without credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloud-dev-nats-"));
  try {
    await prepareDevNats(directory);
    const adminSeed = await readFile(`${directory}/admin.seed`);
    const testSeed = await readFile(`${directory}/test.seed`);
    const admin = nkeys.fromSeed(adminSeed);
    const tester = nkeys.fromSeed(testSeed);
    try {
      const config = await readFile(`${directory}/system.conf`, "utf8");
      expect(config).not.toContain(adminSeed.toString());
      expect(config).not.toContain(testSeed.toString());
      expect(config).toContain("no_auth_user: dev");
      expect(config).toContain('system_account: "$SYS"');
      expect(config).toContain(`"$SYS" { users: [{ nkey: "${admin.getPublicKey()}" }] }`);
      expect(config).toContain("DEV { users: [{ user: dev }], jetstream: enabled }");
      expect(config).toContain(`TEST { users: [{ nkey: "${tester.getPublicKey()}" }], jetstream: {`);

      // The creds file signs as the TEST user; the server ignores its JWT without an operator.
      const creds = await readFile(`${directory}/test.creds`);
      const auth = credsAuthenticator(creds)("nonce");
      expect(auth).toMatchObject({ nkey: tester.getPublicKey() });
      expect((await stat(`${directory}/test.creds`)).mode & 0o777).toBe(0o600);

      await chmod(`${directory}/admin.seed`, 0o644);
      await prepareDevNats(directory);
      expect(await readFile(`${directory}/admin.seed`)).toEqual(adminSeed);
      expect(await readFile(`${directory}/test.seed`)).toEqual(testSeed);
      expect((await stat(`${directory}/admin.seed`)).mode & 0o777).toBe(0o600);
      expect(await readFile(`${directory}/system.conf`, "utf8")).toBe(config);
      expect(await readFile(`${directory}/test.creds`)).toEqual(creds);
    } finally {
      admin.clear();
      tester.clear();
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
