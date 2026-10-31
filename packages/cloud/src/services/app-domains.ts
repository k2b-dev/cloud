import { err, fail, ok, type Result } from "@k2b/stdlib";
import type { SQL } from "bun";
import { getApp } from "../_internal/registry";
import { declaresPublicSurface, normalizeAppDomainHost } from "../contracts/app-domains";
import type { User } from "../contracts/shared";
import { sql } from "../runtime/clients";
import { publicCloudOrigin } from "../shared/app-url";
import { type AppDomainStatus, checkAppDomain } from "./app-domain-check";
import { audit } from "./audit";
import { get } from "./settings";

export type AdminAppDomain = {
  host: string;
  redirectTo: string | null;
  createdAt: string;
  active: boolean;
  status: AppDomainStatus | null;
};
type AdminActor = Pick<User, "id" | "uid" | "provider" | "roles">;
type AppInput = { actor: AdminActor; appId: string };
type DomainInput = AppInput & { host: string };
type Row = { host: string; app_id: string; redirect_to: string | null; created_at: Date; status: AppDomainStatus | null };
type Dependencies = { db?: SQL; getApp?: typeof getApp; cloudUrl?: () => string | Promise<string>; probe?: typeof checkAppDomain };
const normalizeHost = (value: string) => (value.includes("\\") ? null : normalizeAppDomainHost(value));
const invalid = (code: string, message: string) => fail({ ...err.badInput(message), code });
const conflict = (code: string, message: string) => fail({ ...err.conflict("App domain"), code, message });
const notFound = () => fail({ ...err.notFound("App domain"), code: "APP_DOMAIN_NOT_FOUND" });
const authorized = (input: AppInput): Result<void> => {
  if (!input.actor.roles.includes("admin")) return fail(err.forbidden("Administrator access required"));
  if (!/^[a-z][a-z0-9-]{0,79}$/.test(input.appId)) return invalid("APP_DOMAIN_INVALID_APP", "Invalid app ID");
  return ok();
};
const domain = (row: Row, active: boolean): AdminAppDomain => ({
  host: row.host,
  redirectTo: row.redirect_to,
  createdAt: row.created_at.toISOString(),
  active,
  status: row.status,
});

/** All domain mutations share one transaction lock; the host primary key also enforces unique ownership. */
export const createAppDomainService = (dependencies: Dependencies = {}) => {
  const app = dependencies.getApp ?? getApp;
  const database = () => dependencies.db ?? sql;
  const active = async (appId: string) => {
    const entry = await app(appId);
    return entry !== null && declaresPublicSurface(entry);
  };
  const record = (db: SQL, input: DomainInput, action: string, redirectTo?: string | null) =>
    audit.record(
      {
        action: `app_domain.${action}`,
        outcome: "allowed",
        actor: { userId: input.actor.id, uid: input.actor.uid, provider: input.actor.provider, roles: input.actor.roles },
        target: { type: "app_domain", id: input.host, label: input.host },
        metadata: { appId: input.appId, ...(redirectTo !== undefined ? { redirectTo } : {}) },
      },
      db,
    );
  const references = (db: SQL, appId: string, host: string) => db<{ host: string }[]>`
    SELECT host FROM settings.app_domains WHERE app_id = ${appId} AND redirect_to = ${host} ORDER BY host`;
  const validateRedirect = async (db: SQL, appId: string, host: string, target: string): Promise<Result<void>> => {
    if (host === target) return invalid("APP_DOMAIN_REDIRECT_TARGET", "A domain cannot redirect to itself");
    const refs = await references(db, appId, host);
    if (refs.length) return conflict("APP_DOMAIN_REFERENCED", `Domains redirect to ${host}: ${refs.map((row) => row.host).join(", ")}`);
    const [row] = await db<Row[]>`SELECT * FROM settings.app_domains WHERE host = ${target} AND app_id = ${appId}`;
    if (!row || row.redirect_to)
      return invalid("APP_DOMAIN_REDIRECT_TARGET", "Redirect target must be a domain of this app without a redirect");
    return ok();
  };

  return {
    async list(input: AppInput): Promise<Result<{ domains: AdminAppDomain[] }>> {
      const permission = authorized(input);
      if (!permission.ok) return permission;
      const [rows, isActive] = await Promise.all([
        database()<Row[]>`SELECT * FROM settings.app_domains WHERE app_id = ${input.appId} ORDER BY host`,
        active(input.appId),
      ]);
      return ok({ domains: rows.map((row) => domain(row, isActive)) });
    },
    async add(input: DomainInput & { redirectTo?: string }): Promise<Result<AdminAppDomain>> {
      const permission = authorized(input);
      if (!permission.ok) return permission;
      const host = normalizeHost(input.host);
      if (!host) return invalid("APP_DOMAIN_INVALID_HOST", "Expected a DNS host name without a port, path or wildcard");
      const cloudHost = normalizeAppDomainHost(
        new URL(publicCloudOrigin(await (dependencies.cloudUrl ?? (() => get<string>("app.url")))())).hostname,
      );
      if (host === cloudHost) return invalid("APP_DOMAIN_CLOUD_HOST", "The Cloud host cannot be assigned to an app");
      const isActive = await active(input.appId);
      const redirectTo = input.redirectTo === undefined ? null : normalizeHost(input.redirectTo);
      if (input.redirectTo !== undefined && !redirectTo) return invalid("APP_DOMAIN_INVALID_HOST", "Invalid redirect host");
      return database().begin(async (db) => {
        await db`SELECT pg_advisory_xact_lock(hashtextextended('core.app-domains', 0))`;
        const [known] = await db<{ app_id: string }[]>`SELECT app_id FROM platform.application_packages WHERE app_id = ${input.appId}`;
        if (!known) return invalid("APP_DOMAIN_UNKNOWN_APP", "Unknown app ID; the app must have registered its package at least once");
        const existing = await db`SELECT host FROM settings.app_domains WHERE host = ${host}`;
        if (existing.length) return conflict("APP_DOMAIN_ASSIGNED", `Domain ${host} is already assigned`);
        if (redirectTo) {
          const valid = await validateRedirect(db, input.appId, host, redirectTo);
          if (!valid.ok) return valid;
        }
        const [row] = await db<Row[]>`INSERT INTO settings.app_domains(host, app_id, redirect_to)
          VALUES (${host}, ${input.appId}, ${redirectTo}) ON CONFLICT (host) DO NOTHING RETURNING *`;
        if (!row) return conflict("APP_DOMAIN_ASSIGNED", `Domain ${host} is already assigned`);
        await record(db, { ...input, host }, "add", redirectTo);
        return ok(domain(row, isActive));
      });
    },
    async set(input: DomainInput & { redirectTo: string | null }): Promise<Result<AdminAppDomain>> {
      const permission = authorized(input);
      if (!permission.ok) return permission;
      const host = normalizeHost(input.host);
      if (!host) return invalid("APP_DOMAIN_INVALID_HOST", "Invalid domain host");
      const redirectTo = input.redirectTo === null ? null : normalizeHost(input.redirectTo);
      if (input.redirectTo !== null && !redirectTo) return invalid("APP_DOMAIN_INVALID_HOST", "Invalid redirect host");
      const isActive = await active(input.appId);
      return database().begin(async (db) => {
        await db`SELECT pg_advisory_xact_lock(hashtextextended('core.app-domains', 0))`;
        const [existing] = await db<Row[]>`SELECT * FROM settings.app_domains WHERE host = ${host} AND app_id = ${input.appId}`;
        if (!existing) return notFound();
        if (redirectTo) {
          const valid = await validateRedirect(db, input.appId, host, redirectTo);
          if (!valid.ok) return valid;
        }
        const [row] = await db<
          Row[]
        >`UPDATE settings.app_domains SET redirect_to = ${redirectTo} WHERE host = ${host} AND app_id = ${input.appId} RETURNING *`;
        if (!row) return notFound();
        await record(db, { ...input, host }, "set", redirectTo);
        return ok(domain(row, isActive));
      });
    },
    async remove(input: DomainInput): Promise<Result<{ deleted: true }>> {
      const permission = authorized(input);
      if (!permission.ok) return permission;
      const host = normalizeHost(input.host);
      if (!host) return invalid("APP_DOMAIN_INVALID_HOST", "Invalid domain host");
      return database().begin(async (db) => {
        await db`SELECT pg_advisory_xact_lock(hashtextextended('core.app-domains', 0))`;
        const refs = await references(db, input.appId, host);
        if (refs.length) return conflict("APP_DOMAIN_REFERENCED", `Domains redirect to ${host}: ${refs.map((row) => row.host).join(", ")}`);
        const rows = await db`DELETE FROM settings.app_domains WHERE host = ${host} AND app_id = ${input.appId} RETURNING host`;
        if (!rows.length) return notFound();
        await record(db, { ...input, host }, "remove");
        return ok({ deleted: true as const });
      });
    },
    async check(input: DomainInput): Promise<Result<{ status: AppDomainStatus | null }>> {
      const permission = authorized(input);
      if (!permission.ok) return permission;
      const host = normalizeHost(input.host);
      if (!host) return invalid("APP_DOMAIN_INVALID_HOST", "Invalid domain host");
      const db = database();
      const [claimed] = await db<{ check_started_at: string }[]>`UPDATE settings.app_domains SET check_started_at = now()
        WHERE host = ${host} AND app_id = ${input.appId} AND (check_started_at IS NULL OR check_started_at <= now() - interval '60 seconds')
        RETURNING check_started_at::text`;
      if (!claimed) {
        const [row] = await db<Row[]>`SELECT * FROM settings.app_domains WHERE host = ${host} AND app_id = ${input.appId}`;
        return row ? ok({ status: row.status }) : notFound();
      }
      const status = await (dependencies.probe ?? checkAppDomain)(host);
      // A removed/reassigned domain must never inherit an earlier owner's in-flight result.
      await db`UPDATE settings.app_domains SET status = ${JSON.stringify(status)}::jsonb
        WHERE host = ${host} AND app_id = ${input.appId} AND check_started_at = ${claimed.check_started_at}::timestamptz`;
      return ok({ status });
    },
  };
};

export const appDomains = createAppDomainService();
