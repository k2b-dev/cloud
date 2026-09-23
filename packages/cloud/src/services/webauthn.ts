import { err, fail, ok, type Result } from "@k2b/stdlib";
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type WebAuthnCredential,
} from "@simplewebauthn/server";
import { redis, sql } from "bun";
import type { User, WebAuthnPasskey } from "../contracts/shared";
import { accounts } from "./accounts";
import { audit } from "./audit";
import { logger } from "./logging";
import { isUniqueViolation, toPgTextArray } from "./postgres";
import { coreSettings } from "./settings/api";

const CHALLENGE_TTL_SECONDS = 300;
const REGISTRATION_CHALLENGE_PREFIX = "webauthn:registration:";
const AUTHENTICATION_CHALLENGE_PREFIX = "webauthn:authentication:";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i;
const log = logger("auth:webauthn");

type DbPasskeyRow = {
  id: string;
  user_id: string;
  name: string;
  credential_id: string;
  public_key: Uint8Array;
  counter: string | number | bigint;
  transports: string[];
  device_type: string | null;
  backed_up: boolean;
  created_at: Date;
  last_used_at: Date | null;
};

type DbPasskeyWithUserRow = DbPasskeyRow & {
  user_account_expires: Date | null;
};

type StoredWebAuthnPasskey = WebAuthnPasskey & {
  credentialId: string;
};

export type WebAuthnRp = {
  rpName: string;
  rpID: string;
  origin: string;
};

export const resolveWebAuthnRp = (config: { appUrl: string; appName: string }): WebAuthnRp => {
  const rawAppUrl = config.appUrl.trim();
  const hasProtocol = /^https?:\/\//i.test(rawAppUrl);
  const parseUrl = (value: string) => new URL(value);
  const hostname = hasProtocol ? parseUrl(rawAppUrl).hostname : parseUrl(`https://${rawAppUrl}`).hostname;
  const isBareLocalhost =
    !hasProtocol && (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]");
  const withProtocol = hasProtocol ? rawAppUrl : `${isBareLocalhost ? "http" : "https"}://${rawAppUrl}`;
  const url = new URL(withProtocol);
  const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalhost)) {
    throw new Error("WebAuthn requires an HTTPS app.url, except for localhost development.");
  }
  return {
    rpName: config.appName.trim() || "Cloud",
    rpID: url.hostname,
    origin: url.origin,
  };
};

const loadRp = async (): Promise<WebAuthnRp> =>
  resolveWebAuthnRp({
    appUrl: await coreSettings.get<string>("app.url"),
    appName: await coreSettings.get<string>("app.name"),
  });

const loadRpResult = async (): Promise<Result<WebAuthnRp>> => {
  try {
    return ok(await loadRp());
  } catch (error) {
    return fail(err.badInput(error instanceof Error ? error.message : "Invalid WebAuthn configuration."));
  }
};

const mapStoredPasskey = (row: DbPasskeyRow): StoredWebAuthnPasskey => ({
  id: row.id,
  userId: row.user_id,
  name: row.name,
  credentialId: row.credential_id,
  transports: row.transports ?? [],
  deviceType: row.device_type,
  backedUp: row.backed_up,
  createdAt: row.created_at.toISOString(),
  lastUsedAt: row.last_used_at?.toISOString() ?? null,
});

const mapPasskey = (row: DbPasskeyRow): WebAuthnPasskey => {
  const { credentialId: _, ...passkey } = mapStoredPasskey(row);
  return passkey;
};

const actorForUser = (user: Pick<User, "id" | "uid" | "provider" | "roles">) => ({
  userId: user.id,
  uid: user.uid,
  provider: user.provider,
  roles: user.roles,
});

const challengeKey = (prefix: string, id: string) => `${prefix}${id}`;

const storeRegistrationChallenge = async (userId: string, challenge: string): Promise<void> => {
  await redis.set(challengeKey(REGISTRATION_CHALLENGE_PREFIX, userId), challenge, "EX", CHALLENGE_TTL_SECONDS);
};

const consumeRegistrationChallenge = async (userId: string): Promise<string | null> => {
  return redis.getdel(challengeKey(REGISTRATION_CHALLENGE_PREFIX, userId));
};

const storeAuthenticationChallenge = async (challenge: string): Promise<void> => {
  await redis.set(challengeKey(AUTHENTICATION_CHALLENGE_PREFIX, challenge), "1", "EX", CHALLENGE_TTL_SECONDS);
};

const consumeAuthenticationChallenge = async (challenge: string): Promise<boolean> => {
  const value = await redis.getdel(challengeKey(AUTHENTICATION_CHALLENGE_PREFIX, challenge));
  return value === "1";
};

const userIdToWebAuthnBytes = (userId: string): WebAuthnCredential["publicKey"] =>
  new TextEncoder().encode(userId) as WebAuthnCredential["publicKey"];

const toCredential = (row: DbPasskeyRow): WebAuthnCredential => ({
  id: row.credential_id,
  publicKey: new Uint8Array(row.public_key) as WebAuthnCredential["publicKey"],
  counter: Number(row.counter),
  transports: row.transports ?? [],
});

const isExpired = (date: Date | null): boolean => Boolean(date && date.getTime() <= Date.now());

const listStoredForUser = async (params: { userId: string }): Promise<StoredWebAuthnPasskey[]> => {
  const rows = await sql<DbPasskeyRow[]>`
    SELECT id, user_id, name, credential_id, public_key, counter, transports, device_type,
      backed_up, created_at, last_used_at
    FROM auth.webauthn_credentials
    WHERE user_id = ${params.userId}::uuid
    ORDER BY created_at DESC
  `;
  return rows.map(mapStoredPasskey);
};

export const listForUser = async (params: { userId: string }): Promise<WebAuthnPasskey[]> => {
  const rows = await listStoredForUser(params);
  return rows.map(({ credentialId: _, ...passkey }) => passkey);
};

export const beginRegistration = async (params: { user: User }): Promise<Result<PublicKeyCredentialCreationOptionsJSON>> => {
  const rpResult = await loadRpResult();
  if (!rpResult.ok) return rpResult;
  const rp = rpResult.data;
  const existing = await listStoredForUser({ userId: params.user.id });
  const options = await generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpID,
    userID: userIdToWebAuthnBytes(params.user.id),
    userName: params.user.mail ?? params.user.uid,
    userDisplayName: params.user.displayName || params.user.uid,
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
    excludeCredentials: existing.map((credential) => ({
      id: credential.credentialId,
      transports: credential.transports,
    })),
  });

  await storeRegistrationChallenge(params.user.id, options.challenge);
  return ok(options);
};

export const finishRegistration = async (params: {
  user: User;
  name: string;
  response: RegistrationResponseJSON;
}): Promise<Result<WebAuthnPasskey>> => {
  const name = params.name.trim();
  if (!name) return fail(err.badInput("Passkey name is required."));
  if (name.length > 120) return fail(err.badInput("Passkey name must be 120 characters or fewer."));

  const expectedChallenge = await consumeRegistrationChallenge(params.user.id);
  if (!expectedChallenge) return fail(err.badInput("Passkey registration expired. Please try again."));

  const rpResult = await loadRpResult();
  if (!rpResult.ok) return rpResult;
  const rp = rpResult.data;
  const verification = await verifyRegistrationResponse({
    response: params.response,
    expectedChallenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    requireUserVerification: true,
  }).catch((error) => {
    log.warn("Passkey registration verification failed", {
      userId: params.user.id,
      rpID: rp.rpID,
      origin: rp.origin,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
  if (!verification) return fail(err.badInput("Passkey registration could not be verified."));
  if (!verification.verified) return fail(err.badInput("Passkey registration could not be verified."));

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const transports = params.response.response.transports ?? [];

  try {
    return sql.begin(async (tx) => {
      const [row] = await tx<DbPasskeyRow[]>`
        INSERT INTO auth.webauthn_credentials (
          user_id,
          name,
          credential_id,
          public_key,
          counter,
          transports,
          device_type,
          backed_up
        )
        VALUES (
          ${params.user.id}::uuid,
          ${name},
          ${credential.id},
          ${Buffer.from(credential.publicKey)},
          ${credential.counter},
          ${toPgTextArray(transports)}::text[],
          ${credentialDeviceType},
          ${credentialBackedUp}
        )
        RETURNING id, user_id, name, credential_id, public_key, counter, transports, device_type,
          backed_up, created_at, last_used_at
      `;
      const result = row ? ok(mapPasskey(row)) : fail(err.badInput("Passkey could not be saved."));
      return audit.recordResult({
        action: "webauthn_credential.create",
        actor: actorForUser(params.user),
        target: { type: "webauthn_credential", id: row?.id ?? null, label: name },
        metadata: {
          deviceType: credentialDeviceType,
          backedUp: credentialBackedUp,
          transports,
        },
        result,
        db: tx,
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) return fail(err.conflict("Passkey"));
    throw error;
  }
};

export const beginAuthentication = async (): Promise<Result<PublicKeyCredentialRequestOptionsJSON>> => {
  const rpResult = await loadRpResult();
  if (!rpResult.ok) return rpResult;
  const rp = rpResult.data;
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    userVerification: "required",
  });
  await storeAuthenticationChallenge(options.challenge);
  return ok(options);
};

const findCredentialForAuthentication = async (credentialId: string): Promise<DbPasskeyWithUserRow | null> => {
  const [row] = await sql<DbPasskeyWithUserRow[]>`
    SELECT c.id, c.user_id, c.name, c.credential_id, c.public_key, c.counter, c.transports,
      c.device_type, c.backed_up, c.created_at, c.last_used_at, u.account_expires AS user_account_expires
    FROM auth.webauthn_credentials c
    JOIN auth.users u ON u.id = c.user_id
    WHERE c.credential_id = ${credentialId}
    LIMIT 1
  `;
  return row ?? null;
};

export const finishAuthentication = async (params: {
  response: AuthenticationResponseJSON;
}): Promise<Result<{ user: User; passkey: WebAuthnPasskey }>> => {
  const row = await findCredentialForAuthentication(params.response.id);
  if (!row) return fail(err.unauthenticated("Passkey could not be verified."));
  if (isExpired(row.user_account_expires)) return fail(err.forbidden("Your account has expired. Contact an administrator."));

  const rpResult = await loadRpResult();
  if (!rpResult.ok) return rpResult;
  const rp = rpResult.data;
  const verification = await verifyAuthenticationResponse({
    response: params.response,
    expectedChallenge: consumeAuthenticationChallenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    credential: toCredential(row),
    requireUserVerification: true,
  }).catch((error) => {
    log.warn("Passkey authentication verification failed", {
      credentialId: row.id,
      userId: row.user_id,
      rpID: rp.rpID,
      origin: rp.origin,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
  if (!verification) return fail(err.unauthenticated("Passkey could not be verified."));
  if (!verification.verified) return fail(err.unauthenticated("Passkey could not be verified."));

  const user = await accounts.users.get({ id: row.user_id });
  if (!user) return fail(err.unauthenticated("Passkey user not found."));
  if (user.accountExpires && new Date(user.accountExpires).getTime() <= Date.now()) {
    return fail(err.forbidden("Your account has expired. Contact an administrator."));
  }

  return sql.begin(async (tx) => {
    const [updated] = await tx<DbPasskeyRow[]>`
      UPDATE auth.webauthn_credentials
      SET counter = ${verification.authenticationInfo.newCounter},
        device_type = ${verification.authenticationInfo.credentialDeviceType},
        backed_up = ${verification.authenticationInfo.credentialBackedUp},
        last_used_at = now()
      WHERE id = ${row.id}::uuid
      RETURNING id, user_id, name, credential_id, public_key, counter, transports, device_type,
        backed_up, created_at, last_used_at
    `;
    const passkey = mapPasskey(updated ?? row);
    const result = ok({ user, passkey });
    return audit.recordResult({
      action: "webauthn_credential.authenticate",
      actor: actorForUser(user),
      target: { type: "webauthn_credential", id: row.id, label: row.name },
      metadata: {
        deviceType: verification.authenticationInfo.credentialDeviceType,
        backedUp: verification.authenticationInfo.credentialBackedUp,
      },
      result,
      db: tx,
    });
  });
};

export const deleteForUser = async (params: { user: User; id: string }): Promise<Result<void>> => {
  if (!UUID_PATTERN.test(params.id)) return fail(err.notFound("Passkey"));

  return sql.begin(async (tx) => {
    const [row] = await tx<Pick<DbPasskeyRow, "id" | "name">[]>`
      DELETE FROM auth.webauthn_credentials
      WHERE id = ${params.id}::uuid
        AND user_id = ${params.user.id}::uuid
      RETURNING id, name
    `;
    const result = row ? ok() : fail(err.notFound("Passkey"));
    return audit.recordResult({
      action: "webauthn_credential.delete",
      actor: actorForUser(params.user),
      target: { type: "webauthn_credential", id: params.id, label: row?.name ?? null },
      result,
      db: tx,
    });
  });
};

export const webauthn = {
  resolveWebAuthnRp,
  listForUser,
  beginRegistration,
  finishRegistration,
  beginAuthentication,
  finishAuthentication,
  deleteForUser,
};
