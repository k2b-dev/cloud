import { getApp, sql } from "@k2b/cloud";
import { getCapabilityCatalogApp, invokeCapabilityWithDataSchema } from "@k2b/cloud/capabilities/server";
import { CloudResourceReaderViewSchema, cloudResourceRefAppId, resolveCapabilityResourceReader } from "@k2b/cloud/contracts";
import { getEffectivePermission, type RequestAuthority, userFromActor } from "@k2b/cloud/server";
import { canManageAppAccess } from "@k2b/cloud/services";
import { z } from "zod";
import type { Code, CodeOwner, CodePermission } from "./contracts";

/** All Code reads and writes retain the caller's credential ceiling. No ambient user field is authority. */
export type CodeContext = { authority: RequestAuthority; locale?: string; signal?: AbortSignal };
export class CodeDataError extends Error {
  constructor(
    readonly code: "FORBIDDEN" | "NOT_FOUND" | "BAD_INPUT" | "CONFLICT",
    message: string,
  ) {
    super(message);
  }
}
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
    !(credential === "api_key" && scopes.length === 0) &&
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
    return { title: app.name, admin: await canManageAppAccess(context.authority, app) };
  }
  const appId = cloudResourceRefAppId(owner.ref);
  const catalog = await getCapabilityCatalogApp(appId, context.locale, context.authority);
  if (!catalog.ok) throw new Error("Code owner provider unavailable");
  const reader = catalog.data && resolveCapabilityResourceReader(catalog.data.manifest, owner.ref);
  if (!reader) return null;
  const result = await invokeCapabilityWithDataSchema(
    { appId, capabilityId: reader.localId, kind: "query", input: { id: owner.ref.id } },
    z.object({ view: CloudResourceReaderViewSchema }),
    { authority: context.authority, locale: context.locale, signal: context.signal },
  );
  if (!result.ok) {
    if (["FORBIDDEN", "NOT_FOUND", "APP_ACCESS_DENIED"].includes(result.error.code)) return null;
    throw new Error("Code owner reader unavailable");
  }
  return { title: result.data.data.view.title, admin: result.data.data.view.permission === "admin" };
};

/** Default editors are the personal owner or live owner administrators; explicit shares add editors/readers. */
export const codePermission = async (code: Code, context: CodeContext): Promise<CodePermission | null> => {
  const user = codePerson(context);
  if (user.roles.includes("admin")) return "editor";
  if (code.owner.kind === "person" && code.owner.userId === user.id) return "editor";
  const entries = await sql<{ access_id: string }[]>`SELECT access_id FROM code.access WHERE code_id = ${code.id}`;
  const permission = await getEffectivePermission({
    accessIds: entries.map((row) => row.access_id),
    subject: context.authority.accessSubject,
  });
  if (permission === "write" || permission === "admin") return "editor";
  if (code.owner.kind !== "person" && (await readCodeOwner(code.owner, context))?.admin) return "editor";
  return permission === "read" ? "reader" : null;
};
/** Missing and inaccessible Code have the same result. */
export const requireCodePermission = async (code: Code, context: CodeContext, editor = false): Promise<CodePermission> => {
  const permission = await codePermission(code, context);
  if (!permission || (editor && permission !== "editor")) throw new CodeDataError("NOT_FOUND", "Code not found.");
  if (editor) codePerson(context, true);
  return permission;
};
/** Service-account names are stable machine identities; this label always comes from the live owner reader. */
export const codeAccountDisplayName = async (code: Code, context: CodeContext): Promise<string | null> => {
  await requireCodePermission(code, context);
  if (!code.serviceAccountId) return null;
  const owner = await readCodeOwner(code.owner, context);
  return owner ? (context.locale?.startsWith("de") ? `Code von ${owner.title}` : `Code of ${owner.title}`) : null;
};
