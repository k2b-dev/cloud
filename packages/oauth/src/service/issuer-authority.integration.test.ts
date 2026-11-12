import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import { connections, sql } from "@k2b/cloud";
import { OAuthNewAccessNoticeSchema } from "@k2b/cloud/contracts";
import { toPgTextArray } from "@k2b/cloud/services";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { migrate as migrateAppApproval } from "../../../core/src/migrate/core/app-approval";
import { migrate as migrateAuth } from "../../../core/src/migrate/core/auth";
import { migrate as migrateRegistry } from "../../../core/src/migrate/core/oauth-clients";
import { migrate as migrateSettings } from "../../../core/src/migrate/core/settings";
import { migrate } from "../migrate";
import { notifyPendingOAuthNewAccess } from "./access-notices";
import { registerAll, update } from "./clients";
import { finalizeOAuthAuthority, InvalidIssuerAuthorityError, releaseOAuthAuthority, stageOAuthAuthority } from "./issuer-authority";
import * as refreshTokens from "./refresh-tokens";

const issuer = "https://cloud.example.test";
databaseSuite()("OAuth issuer owns policy, reservations and notices", () => {
  const fixtures: { userId: string; clientId: string }[] = [];
  let previousAppId: string;
  beforeAll(async () => {
    await migrateAuth();
    await migrateSettings();
    await migrateAppApproval();
    await migrateRegistry();
    await migrate();
    previousAppId = connections().appId;
    connections().appId = "oauth";
  });
  beforeEach(async () => {
    const [clock] = await sql<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    setSystemTime(clock!.now);
  });
  afterEach(async () => {
    setSystemTime();
    for (const f of fixtures.splice(0)) {
      await sql`DELETE FROM auth.oauth_clients WHERE client_id=${f.clientId}`;
      await sql`DELETE FROM oauth.clients WHERE client_id=${f.clientId}`;
      await sql`DELETE FROM auth.users WHERE id=${f.userId}::uuid`;
    }
  });
  afterAll(() => {
    connections().appId = previousAppId;
  });
  const fixture = async (scopes = ["openid"]) => {
    const userId = crypto.randomUUID(),
      clientId = `issuer-${crypto.randomUUID()}`,
      code = crypto.randomUUID();
    await sql`INSERT INTO auth.users(id,uid,provider,profile,auth_epoch) VALUES (${userId}::uuid,${userId},'local','user',7)`;
    const [client] = await sql<{ id: string }[]>`INSERT INTO oauth.clients(name,client_id,redirect_uris,scopes,audiences)
      VALUES (${clientId},${clientId},ARRAY['https://client.test/callback'],${toPgTextArray(scopes)}::text[],ARRAY['https://api.test']) RETURNING id`;
    await sql`INSERT INTO oauth.codes(code,client_id,user_id,auth_epoch,redirect_uri,scopes,audiences,used,confirmed_at)
      VALUES (${code},${clientId},${userId}::uuid,7,'https://client.test/callback',${toPgTextArray(scopes)}::text[],ARRAY['cloud',${clientId}],true,now())`;
    const f = { userId, clientId, clientUuid: client!.id, code, grant: { kind: "authorization_code" as const, code } };
    fixtures.push(f);
    return f;
  };
  const stage = (grant: Parameters<typeof releaseOAuthAuthority>[0]) =>
    stageOAuthAuthority([{ kind: "user_access", grant, expiresIn: 60 }], issuer, new Date(Date.now() + 1800_000));

  test("reserves one consumed code exactly once, independently of Core, and releases only on a known rejection", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([stage(f.grant), stage(f.grant)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await sql`SELECT authority_issued_at FROM oauth.codes WHERE code=${f.code}`)[0].authority_issued_at).toBeInstanceOf(Date);
    await releaseOAuthAuthority(f.grant);
    expect((await sql`SELECT used,authority_issued_at FROM oauth.codes WHERE code=${f.code}`)[0]).toMatchObject({
      used: false,
      authority_issued_at: null,
    });
    // The protocol must consume the credential again before staging it.
    await expect(stage(f.grant)).rejects.toBeInstanceOf(InvalidIssuerAuthorityError);
    await sql`UPDATE oauth.codes SET used=true WHERE code=${f.code}`;
    const staged = await stage(f.grant);
    expect(staged.statement).toMatchObject({
      clientId: f.clientId,
      subject: { kind: "user", userId: f.userId, authEpoch: 7 },
      scopes: ["openid"],
      audiences: ["cloud", f.clientId],
      terminalLoginId: null,
    });
  });
  test.each(["unconsumed", "epoch", "expired", "scope", "profile", "specific", "resource", "dynamic-origin"] as const)(
    "revalidates private client and grant policy before reserving: %s",
    async (scenario) => {
      const f = await fixture();
      if (scenario === "unconsumed") await sql`UPDATE oauth.codes SET used=false WHERE code=${f.code}`;
      if (scenario === "epoch") await sql`UPDATE oauth.codes SET auth_epoch=6 WHERE code=${f.code}`;
      if (scenario === "expired") await sql`UPDATE oauth.codes SET expires_at=now()-interval '1 minute' WHERE code=${f.code}`;
      if (scenario === "scope") await sql`UPDATE oauth.clients SET scopes=ARRAY['profile'] WHERE client_id=${f.clientId}`;
      if (scenario === "profile") await sql`UPDATE oauth.clients SET allowed_profiles=ARRAY['guest'] WHERE client_id=${f.clientId}`;
      if (scenario === "specific") await sql`UPDATE oauth.clients SET access_mode='specific' WHERE client_id=${f.clientId}`;
      if (scenario === "resource" || scenario === "dynamic-origin") {
        await sql`UPDATE oauth.codes SET resource='https://elsewhere.test/api',audiences=ARRAY['https://elsewhere.test/api'] WHERE code=${f.code}`;
        if (scenario === "dynamic-origin") await sql`UPDATE oauth.clients SET registration_kind='dynamic' WHERE client_id=${f.clientId}`;
      }
      await expect(stage(f.grant)).rejects.toBeInstanceOf(InvalidIssuerAuthorityError);
      expect((await sql`SELECT authority_issued_at FROM oauth.codes WHERE code=${f.code}`)[0].authority_issued_at).toBeNull();
    },
  );
  test("specific access follows the current explicit user grant", async () => {
    const f = await fixture();
    await sql`UPDATE oauth.clients SET access_mode='specific' WHERE client_id=${f.clientId}`;
    await sql`INSERT INTO oauth.client_access_users(client_id,user_id) VALUES (${f.clientUuid}::uuid,${f.userId}::uuid)`;
    expect((await stage(f.grant)).statement.subject).toEqual({ kind: "user", userId: f.userId, authEpoch: 7 });
  });
  test("new offline access needs a matching confirmed family and activation follows a successful signature", async () => {
    const f = await fixture(["openid", "offline_access"]),
      familyId = crypto.randomUUID();
    await expect(stage(f.grant)).rejects.toBeInstanceOf(InvalidIssuerAuthorityError);
    await sql`INSERT INTO oauth.refresh_token_families(id,client_id,user_id,auth_epoch,status,scopes,audiences,expires_at,notified_at)
      VALUES (${familyId}::uuid,${f.clientId},${f.userId}::uuid,7,'reserved',ARRAY['openid','offline_access'],
        ARRAY['cloud',${f.clientId}],now()+interval '30 minutes',now())`;
    await sql`UPDATE oauth.codes SET confirmed_at=NULL WHERE code=${f.code}`;
    await expect(stage({ ...f.grant, familyId })).rejects.toBeInstanceOf(InvalidIssuerAuthorityError);
    await sql`UPDATE oauth.codes SET confirmed_at=now() WHERE code=${f.code}`;
    const staged = await stage({ ...f.grant, familyId });
    expect((await sql`SELECT status FROM oauth.refresh_token_families WHERE id=${familyId}::uuid`)[0].status).toBe("reserved");
    await finalizeOAuthAuthority(staged);
    expect((await sql`SELECT status,notified_at FROM oauth.refresh_token_families WHERE id=${familyId}::uuid`)[0]).toMatchObject({
      status: "active",
      notified_at: null,
    });
    await expect(finalizeOAuthAuthority(staged)).rejects.toThrow("could not be activated");
  });
  const device = async () => {
    const f = await fixture(),
      id = crypto.randomUUID();
    await sql`UPDATE oauth.clients SET is_public=true,allow_device_grant=true WHERE client_id=${f.clientId}`;
    const [row] = await sql<{ expires_at: Date }[]>`INSERT INTO oauth.device_authorizations(id,device_code_hash,user_code_hash,client_id,
      scopes,audiences,status,user_id,auth_epoch,expires_at,login_lifetime_seconds)
      VALUES (${id}::uuid,${id},${id},${f.clientId},ARRAY['openid'],ARRAY['cloud',${f.clientId}],
        'consumed',${f.userId}::uuid,7,now()+interval '5 minutes',3600) RETURNING expires_at`;
    return { ...f, id, deadline: row!.expires_at, deviceGrant: { kind: "device_code" as const, deviceAuthorizationId: id } };
  };
  test("a consumed device grant stages once and current device eligibility remains issuer policy", async () => {
    const f = await device();
    expect((await stage(f.deviceGrant)).statement.subject).toEqual({ kind: "user", userId: f.userId, authEpoch: 7 });
    await expect(stage(f.deviceGrant)).rejects.toBeInstanceOf(InvalidIssuerAuthorityError);
    await releaseOAuthAuthority(f.deviceGrant);
    expect((await sql`SELECT status,authority_issued_at FROM oauth.device_authorizations WHERE id=${f.id}::uuid`)[0]).toMatchObject({
      status: "approved",
      authority_issued_at: null,
    });
    await sql`UPDATE oauth.device_authorizations SET status='consumed' WHERE id=${f.id}::uuid`;
    await sql`UPDATE oauth.clients SET allow_device_grant=false WHERE client_id=${f.clientId}`;
    await expect(stage(f.deviceGrant)).rejects.toBeInstanceOf(InvalidIssuerAuthorityError);
    expect(
      (await sql`SELECT authority_issued_at FROM oauth.device_authorizations WHERE id=${f.id}::uuid`)[0].authority_issued_at,
    ).toBeNull();
  });
  test.each(["current", "missing", "issuer", "client", "scopes", "lifetime", "deadline", "epoch", "denied"] as const)(
    "terminal evidence must match the issuer's exact private device grant: %s",
    async (scenario) => {
      const f = await device(),
        loginId = crypto.randomUUID();
      await sql`UPDATE oauth.device_authorizations SET app_approval=true WHERE id=${f.id}::uuid`;
      if (scenario !== "missing")
        await sql`INSERT INTO auth.app_logins(id,issuer,user_id,auth_epoch,category,browser_hash,challenge,
      comparison,state,expires_at,kind,device_authorization_id,client_id,scopes,lifetime_seconds,oauth_issuer_app_id,
      oauth_client_name,oauth_grant_expires_at)
      VALUES (${loginId}::uuid,${issuer},${f.userId}::uuid,7,'login','hash','challenge','012345','approved',now()+interval '5 minutes',
        'terminal',${f.id}::uuid,${f.clientId},ARRAY['openid'],3600,'oauth','CLI',${f.deadline})`;
      if (scenario === "issuer") await sql`UPDATE auth.app_logins SET oauth_issuer_app_id='another-issuer' WHERE id=${loginId}::uuid`;
      if (scenario === "client") await sql`UPDATE auth.app_logins SET client_id='another-client' WHERE id=${loginId}::uuid`;
      if (scenario === "scopes") await sql`UPDATE auth.app_logins SET scopes=ARRAY['openid','write'] WHERE id=${loginId}::uuid`;
      if (scenario === "lifetime") await sql`UPDATE auth.app_logins SET lifetime_seconds=1800 WHERE id=${loginId}::uuid`;
      if (scenario === "deadline")
        await sql`UPDATE auth.app_logins SET oauth_grant_expires_at=oauth_grant_expires_at+interval '1 second' WHERE id=${loginId}::uuid`;
      if (scenario === "epoch") await sql`UPDATE auth.app_logins SET auth_epoch=6 WHERE id=${loginId}::uuid`;
      if (scenario === "denied") await sql`UPDATE auth.app_logins SET state='denied' WHERE id=${loginId}::uuid`;
      if (scenario === "current") {
        const staged = await stage(f.deviceGrant);
        expect(staged.statement.terminalLoginId).toBe(loginId);
        expect(staged.terminalConfirmed).toBe(true);
        // Only Core consumes platform approval, together with its signing transaction.
        expect((await sql`SELECT state FROM auth.app_logins WHERE id=${loginId}::uuid`)[0].state).toBe("approved");
      } else {
        await expect(stage(f.deviceGrant)).rejects.toBeInstanceOf(InvalidIssuerAuthorityError);
        expect(
          (await sql`SELECT authority_issued_at FROM oauth.device_authorizations WHERE id=${f.id}::uuid`)[0].authority_issued_at,
        ).toBeNull();
      }
    },
  );
  test("startup registers clients written after the Core backfill and refreshes names idempotently", async () => {
    const f = await fixture();
    expect(await sql`SELECT * FROM auth.oauth_clients WHERE client_id=${f.clientId}`).toHaveLength(0);
    await registerAll();
    await registerAll();
    expect((await sql`SELECT issuer_app_id,status,name FROM auth.oauth_clients WHERE client_id=${f.clientId}`)[0]).toEqual({
      issuer_app_id: "oauth",
      status: "active",
      name: f.clientId,
    });
    await sql`UPDATE oauth.clients SET name='Rollout update' WHERE client_id=${f.clientId}`;
    await registerAll();
    expect((await sql`SELECT name FROM auth.oauth_clients WHERE client_id=${f.clientId}`)[0].name).toBe("Rollout update");
    const otherId = `third-party-${crypto.randomUUID()}`;
    await sql`INSERT INTO auth.oauth_clients(client_id,issuer_app_id,name,status) VALUES (${otherId},'another-issuer','Other client','active')`;
    try {
      // Model an old replica deleting after Core's one-time backfill.
      await sql`DELETE FROM oauth.clients WHERE client_id=${f.clientId}`;
      await registerAll();
      expect((await sql`SELECT status FROM auth.oauth_clients WHERE client_id=${f.clientId}`)[0].status).toBe("deleted");
      expect(await sql`SELECT client_id FROM auth.oauth_clients WHERE client_id=${otherId}`).toHaveLength(1);
    } finally {
      await sql`DELETE FROM auth.oauth_clients WHERE client_id=${otherId}`;
    }
  });
  test("legacy 200-character names register, edit and notify with a bounded display name", async () => {
    const f = await fixture();
    const legacyName = "L".repeat(200);
    await sql`UPDATE oauth.clients SET name=${legacyName} WHERE client_id=${f.clientId}`;
    await registerAll();
    expect((await sql`SELECT name FROM auth.oauth_clients WHERE client_id=${f.clientId}`)[0].name).toBe(legacyName.slice(0, 120));
    const edited = await update({
      id: f.clientUuid,
      data: { description: "Edited legacy client" },
      actor: { id: f.userId, uid: f.userId, provider: "local", roles: ["admin"] },
    });
    expect(edited.ok).toBe(true);
    expect((await sql`SELECT name FROM oauth.clients WHERE client_id=${f.clientId}`)[0].name).toBe(legacyName);
    expect((await sql`SELECT name FROM auth.oauth_clients WHERE client_id=${f.clientId}`)[0].name).toBe(legacyName.slice(0, 120));
    const familyId = crypto.randomUUID();
    await sql`INSERT INTO oauth.refresh_token_families(id,client_id,user_id,auth_epoch,status,scopes,audiences,expires_at,notified_at)
      VALUES (${familyId}::uuid,${f.clientId},${f.userId}::uuid,7,'active',ARRAY['openid'],ARRAY['cloud'],now()+interval '1 hour',NULL)`;
    const names: string[] = [];
    await notifyPendingOAuthNewAccess({
      familyId,
      notify: async (notice) => {
        names.push(OAuthNewAccessNoticeSchema.parse(notice).clientName);
      },
    });
    expect(names).toEqual([legacyName.slice(0, 120)]);
  });
  test("newer pending notices are reached despite a full page of older failures", async () => {
    const f = await fixture();
    const newest = crypto.randomUUID();
    await sql`INSERT INTO oauth.refresh_token_families(id,client_id,user_id,auth_epoch,status,scopes,audiences,expires_at,notified_at,created_at)
      SELECT gen_random_uuid(),${f.clientId},${f.userId}::uuid,7,'active',ARRAY['openid'],ARRAY['cloud'],now()+interval '1 hour',NULL,
        now()-n*interval '1 minute' FROM generate_series(1,100) n`;
    await sql`INSERT INTO oauth.refresh_token_families(id,client_id,user_id,auth_epoch,status,scopes,audiences,expires_at,notified_at,created_at)
      VALUES (${newest}::uuid,${f.clientId},${f.userId}::uuid,7,'active',ARRAY['openid'],ARRAY['cloud'],now()+interval '1 hour',NULL,now())`;
    const attempted: string[] = [];
    await expect(
      notifyPendingOAuthNewAccess({
        notify: async (notice) => {
          attempted.push(notice.familyId);
          if (notice.familyId !== newest) throw new Error("Permanent delivery failure");
        },
      }),
    ).rejects.toThrow("remain pending");
    expect(attempted).toHaveLength(100);
    expect(attempted[0]).toBe(newest);
    expect((await sql`SELECT notified_at FROM oauth.refresh_token_families WHERE id=${newest}::uuid`)[0].notified_at).toBeInstanceOf(Date);
  });
  test("expired pending notices stop retrying and cleanup removes their families", async () => {
    const f = await fixture();
    const familyId = crypto.randomUUID();
    await sql`INSERT INTO oauth.refresh_token_families(id,client_id,user_id,auth_epoch,status,scopes,audiences,expires_at,notified_at)
      VALUES (${familyId}::uuid,${f.clientId},${f.userId}::uuid,7,'active',ARRAY['openid'],ARRAY['cloud'],now()-interval '1 minute',NULL)`;
    let attempts = 0;
    await notifyPendingOAuthNewAccess({
      familyId,
      notify: async () => {
        attempts += 1;
        throw new Error("Permanent delivery failure");
      },
    });
    expect(attempts).toBe(0);
    await refreshTokens.cleanup();
    expect(await sql`SELECT id FROM oauth.refresh_token_families WHERE id=${familyId}::uuid`).toHaveLength(0);
  });
  test("notice maintenance retries failed deliveries, retains unexpired revoked access, skips reservations and respects cancellation", async () => {
    const f = await fixture();
    const pending = crypto.randomUUID(),
      reserved = crypto.randomUUID();
    await sql`INSERT INTO oauth.refresh_token_families(id,client_id,user_id,auth_epoch,status,scopes,audiences,expires_at,notified_at)
      VALUES (${pending}::uuid,${f.clientId},${f.userId}::uuid,7,'revoked',ARRAY['openid'],ARRAY['cloud'],now()+interval '1 hour',NULL),
        (${reserved}::uuid,${f.clientId},${f.userId}::uuid,7,'reserved',ARRAY['openid'],ARRAY['cloud'],now()+interval '1 hour',now())`;
    const notices: string[] = [];
    await notifyPendingOAuthNewAccess({
      familyId: reserved,
      notify: async (notice) => {
        notices.push(notice.familyId);
      },
    });
    expect(notices).toEqual([]);
    await expect(
      notifyPendingOAuthNewAccess({
        notify: async (notice) => {
          if (notice.familyId === pending) throw new Error("Delivery failed");
        },
      }),
    ).rejects.toThrow("remain pending");
    await refreshTokens.cleanup();
    expect((await sql`SELECT notified_at FROM oauth.refresh_token_families WHERE id=${pending}::uuid`)[0].notified_at).toBeNull();
    await notifyPendingOAuthNewAccess({
      notify: async (notice) => {
        notices.push(notice.familyId);
      },
      signal: AbortSignal.abort(),
    });
    expect(notices).toEqual([]);
    await notifyPendingOAuthNewAccess({
      notify: async (notice) => {
        notices.push(notice.familyId);
      },
    });
    expect(notices).toContain(pending);
    expect(notices).not.toContain(reserved);
    expect((await sql`SELECT notified_at FROM oauth.refresh_token_families WHERE id=${pending}::uuid`)[0].notified_at).toBeInstanceOf(Date);
    notices.length = 0;
    await notifyPendingOAuthNewAccess({
      notify: async (notice) => {
        notices.push(notice.familyId);
      },
    });
    expect(notices).not.toContain(pending);
  });
});
