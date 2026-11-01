import { getApp, sql } from "@k2b/cloud";
import { getCapabilityCatalogApp, invokeCapabilityWithDataSchema } from "@k2b/cloud/capabilities/server";
import { CloudResourceReaderViewSchema, cloudResourceRefAppId, resolveCapabilityResourceReader } from "@k2b/cloud/contracts";
import { getEffectivePermission, type RequestAuthority, userFromActor } from "@k2b/cloud/server";
import { logger } from "@k2b/cloud/services";
import { i18n } from "@k2b/stdlib";
import type { SQL } from "bun";
import { z } from "zod";
import type { Code, CodeOwner, CodePermission } from "./contracts";

/** All Code reads and writes retain the caller's credential ceiling. No ambient user field is authority. */
export type CodeContext = { authority: RequestAuthority; locale?: string; signal?: AbortSignal; requestId?: string };
export class CodeDataError extends Error {
  constructor(
    readonly code: "FORBIDDEN" | "NOT_FOUND" | "BAD_INPUT" | "CONFLICT",
    message: string,
  ) {
    super(message);
  }
}
/** An owner provider could not answer; existing reader grants remain usable. */
export class CodeOwnerUnavailableError extends Error {}

/** Code accounts themselves have no management/query surface, even if accidentally given a grant. */
export const codePerson = (context: CodeContext, write = false) => {
  const { authority } = context;
  context.signal?.throwIfAborted();
  const user = userFromActor(authority.actor);
  if (
    !user ||
    authority.accessSubject.type !== "user" ||
    authority.accessSubject.userId !== user.id ||
    (authority.actor.kind === "service_account" &&
      (authority.actor.serviceAccount.kind === "code" || authority.actor.serviceAccount.status !== "active"))
  )
    throw new CodeDataError("FORBIDDEN", "Code requires a person.");
  const credential = authority.credentialKind === "invocation" ? authority.actor.delegation?.credentialKind : authority.credentialKind;
  const scopes = authority.scopes;
  if (
    credential !== "session" &&
    credential !== "mandate" &&
    !(
      credential === "api_key" &&
      authority.actor.kind === "service_account" &&
      authority.actor.serviceAccount.kind === "user_delegated" &&
      scopes.length === 0
    ) &&
    !scopes.some((scope) =>
      (write
        ? ["write", "admin", "core:write", "core:admin", "core:*"]
        : ["read", "write", "admin", "core:read", "core:write", "core:admin", "core:*"]
      ).includes(scope),
    )
  )
    throw new CodeDataError("FORBIDDEN", "Credential does not allow Code access.");
  return user;
};

/** Resolve the resource's current title and permission through its canonical reader under this exact authority. */
export const readCodeOwner = async (owner: CodeOwner, context: CodeContext): Promise<{ title: string; admin: boolean } | null> => {
  if (owner.kind === "person") {
    const user = codePerson(context);
    return user.id === owner.userId ? { title: user.displayName || user.uid, admin: true } : null;
  }
  if (owner.kind === "app") {
    const app = await getApp(owner.appId);
    if (!app) return null;
    const entries =
      app.access?.kind === "grants"
        ? await sql<{ access_id: string }[]>`SELECT j.access_id FROM auth.app_access j JOIN auth.access a ON a.id=j.access_id
        WHERE j.app_id=${app.id} AND (a.user_id IS NOT NULL OR a.group_id IS NOT NULL OR a.service_account_id IS NOT NULL)`
        : [];
    const permission = await getEffectivePermission({
      accessIds: entries.map((entry) => entry.access_id),
      subject: context.authority.accessSubject,
    });
    return { title: app.name, admin: permission === "admin" };
  }
  const appId = cloudResourceRefAppId(owner.ref);
  const catalog = await getCapabilityCatalogApp(appId, context.locale, context.authority);
  if (!catalog.ok) {
    if (["FORBIDDEN", "NOT_FOUND", "APP_ACCESS_DENIED"].includes(catalog.error.code)) return null;
    throw new CodeOwnerUnavailableError("Code owner provider unavailable");
  }
  const reader = catalog.data && resolveCapabilityResourceReader(catalog.data.manifest, owner.ref);
  if (!reader) return null;
  const result = await invokeCapabilityWithDataSchema(
    { appId, capabilityId: reader.localId, kind: "query", input: { id: owner.ref.id } },
    z.object({ view: CloudResourceReaderViewSchema }),
    { authority: context.authority, locale: context.locale, signal: context.signal },
  );
  if (!result.ok) {
    if (["FORBIDDEN", "NOT_FOUND", "APP_ACCESS_DENIED"].includes(result.error.code)) return null;
    throw new CodeOwnerUnavailableError("Code owner reader unavailable");
  }
  return { title: result.data.data.view.title, admin: result.data.data.view.permission === "admin" };
};

/** Default editors are the personal owner or live owner administrators; explicit shares add editors/readers.
 * Unfiltered lists skip owner providers; edits fail visibly when live owner authority cannot be checked.
 */
export const codePermission = async (
  code: Code,
  context: CodeContext,
  db: SQL = sql,
  ownerCheck: "read" | "edit" | "skip" = "read",
): Promise<CodePermission | null> => {
  const user = codePerson(context);
  const cloudAdmin = user.roles.includes("admin");
  if (code.owner.kind === "person" && code.owner.userId === user.id) return "editor";
  const entries = await db<{ access_id: string }[]>`SELECT access_id FROM code.shares WHERE code_id = ${code.id}`;
  const permission = await getEffectivePermission(
    {
      accessIds: entries.map((row) => row.access_id),
      subject: context.authority.accessSubject,
    },
    db,
  );
  if (permission === "write" || permission === "admin") return "editor";
  if (code.owner.kind !== "person" && ownerCheck !== "skip") {
    try {
      if ((await readCodeOwner(code.owner, context))?.admin) return "editor";
    } catch (error) {
      if (!(error instanceof CodeOwnerUnavailableError) || ownerCheck === "edit" || (permission !== "read" && !cloudAdmin)) throw error;
      logger("core:code-owner").warn("Code owner unavailable; retaining existing reader access", { codeId: code.id });
    }
  }
  return permission === "read" || cloudAdmin ? "reader" : null;
};
/** Missing and inaccessible Code have the same result. */
export const requireCodePermission = async (code: Code, context: CodeContext, editor = false, db: SQL = sql): Promise<CodePermission> => {
  const permission = await codePermission(code, context, db, editor ? "edit" : "read");
  if (!permission || (editor && permission !== "editor")) throw new CodeDataError("NOT_FOUND", "Code not found.");
  if (editor) codePerson(context, true);
  return permission;
};
const codeMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: { accountName: ({ title }: { title: string }) => `Code of ${title}` },
    de: { accountName: ({ title }) => `Code von ${title}` },
  },
});

/** Live owner presentation uses reader authority, independently of permission to open the Code itself. */
export const codeAccountDisplayName = async (code: Code, context: CodeContext): Promise<string | null> => {
  codePerson(context);
  if (!code.serviceAccountId) return null;
  const owner = await readCodeOwner(code.owner, context);
  const { t } = codeMessages.resolve(context.locale ? [context.locale] : []);
  return owner ? t.accountName({ title: owner.title }) : null;
};
