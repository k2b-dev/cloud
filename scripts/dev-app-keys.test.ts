import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appKeyFingerprint, deriveAppPublicKey, parseAppKey } from "../packages/cloud/src/app-key";
import { DEVELOPMENT_APP_KEYS, DEVELOPMENT_INSTALLATION_ID } from "../packages/cloud/src/runtime/development-keys";
import { prepareDevAppKeys } from "./dev-app-keys";
import { renderDevelopmentKeys } from "./generate-app-deployments";
import { appIds } from "./workspace";

const directories: string[] = [];
afterAll(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
});
test("all workspace apps have reproducible isolated development key files readable by the image user", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-dev-keys-"));
  directories.push(root);
  expect(DEVELOPMENT_APP_KEYS.map((k) => k.appId).sort()).toEqual(
    appIds()
      .filter((id) => id !== "core" && id !== "gateway")
      .sort(),
  );
  await prepareDevAppKeys(root);
  for (const key of DEVELOPMENT_APP_KEYS) {
    const path = join(root, ".local/dev-app-keys", `${key.appId}.key`);
    const value = await readFile(path, "utf8");
    const parsed = parseAppKey(value.trim());
    expect(parsed).toMatchObject({ appId: key.appId, keyId: key.keyId, installationId: DEVELOPMENT_INSTALLATION_ID });
    expect(await deriveAppPublicKey(parsed.seed)).toBe(key.publicKey);
    expect(await appKeyFingerprint(key.publicKey)).toBe(key.fingerprint);
    expect((await stat(path)).mode & 0o777).toBe(0o644);
    await prepareDevAppKeys(root);
    expect(await readFile(path, "utf8")).toBe(value);
  }
});

test("adding a workspace app generates repeatable fixtures without manual key material", async () => {
  const first = await renderDevelopmentKeys(["inventory"], []);
  expect(first).toEqual(await renderDevelopmentKeys(["inventory"], []));
  expect(first.publicKeys).toContain('appId: "inventory"');
  const key = JSON.parse(first.fixtures).keys[0];
  expect(first.publicKeys).toContain(await deriveAppPublicKey(key.seed));
  expect(key.keyId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});
