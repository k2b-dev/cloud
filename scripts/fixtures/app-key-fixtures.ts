import type { SQL } from "bun";
import { formatAppKey } from "../../packages/cloud/src/app-key";

export { signAppProof } from "../../packages/cloud/src/runtime/bootstrap-protocol";

// RFC 8032 Ed25519 test vectors. Public, deterministic test keys only.
export const APP_KEY_FIXTURES = [
  {
    seed: "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A",
    publicKey: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
    fingerprint: "21fe31dfa154a261626bf854046fd227",
  },
  {
    seed: "TM0Imyj_ltqdtsNG7BFOD1uKMZ81q6Yk2oz27U-4pvs",
    publicKey: "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw",
    fingerprint: "39f713d0a644253f04529421b9f51b9b",
  },
  {
    seed: "xaqN9D-fg3vtt0QvMdy3sWbThTUHbwlLhc46LgtEWPc",
    publicKey: "_FHNjmIYoaONpH7QAjDwWAgW7RO6MwOsXeuRFUiQgCU",
    fingerprint: "dac073e0123bdea59dd9b3bda9cf6037",
  },
] as const;
export const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
export const KEY_ID = "22222222-2222-4222-8222-222222222222";

/** A valid private key for isolated transport and startup fixtures; never an operator key. */
export const appKeyFixture = (appId: string) =>
  formatAppKey({ appId, installationId: INSTALLATION_ID, keyId: KEY_ID, seed: APP_KEY_FIXTURES[0].seed });

/** Enroll the same isolated test identity through the migrated credential schema. */
export const enrollTestAppKey = async (db: SQL, appId: string, grants: readonly "oauth:issue"[] = []) => {
  await db`INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
    VALUES (${appId}, 'resource_bound', ${appId}, 'cloud.app', ${appId}) ON CONFLICT DO NOTHING`;
  const [account] = await db<{ id: string }[]>`SELECT id FROM auth.service_accounts
    WHERE kind = 'resource_bound' AND app_id = ${appId} AND resource_type = 'cloud.app' AND resource_id = ${appId}`;
  if (!account) throw new Error("Test app account missing");
  await db`INSERT INTO auth.service_account_credentials (service_account_id, name, kind, public_key, fingerprint, oauth_issue_allowed)
    VALUES (${account.id}::uuid, ${appId}, 'app_key', ${APP_KEY_FIXTURES[0].publicKey}, ${APP_KEY_FIXTURES[0].fingerprint}, ${grants.includes("oauth:issue")})
    ON CONFLICT (service_account_id, public_key) WHERE kind = 'app_key' DO NOTHING`;
  const [key] = await db<{ id: string }[]>`SELECT id FROM auth.service_account_credentials
    WHERE service_account_id = ${account.id}::uuid AND kind = 'app_key' AND public_key = ${APP_KEY_FIXTURES[0].publicKey}`;
  const [installation] = await db<{ id: string }[]>`SELECT id FROM auth.installation WHERE singleton`;
  if (!key || !installation) throw new Error("Test app key missing");
  return {
    keyId: key.id,
    serviceAccountId: account.id,
    value: formatAppKey({ appId, installationId: installation.id, keyId: key.id, seed: APP_KEY_FIXTURES[0].seed }),
  };
};
