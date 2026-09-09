import { createHash } from "node:crypto";
import { sql } from "bun";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { isAccountCategoryAllowed } from "./account-category-policy";
import { isAccountExpired } from "./account-model";
import { verifySessionToken } from "./identity";
import { getIdentityRuntimeConfig } from "./identity/runtime-config";
import { session } from "./session";
import { loadJwtSessionUser } from "./session/user";
import * as settings from "./settings";

/** First-use acceptance, not an automatic re-consent policy for later edits. */
export const legalConsent = {
  documents: async () => {
    const document = async (kind: "terms" | "privacy") => {
      const [mode, url, content] = await Promise.all([
        settings.get<string>(`legal.${kind}.mode`),
        settings.get<string>(`legal.${kind}.url`),
        settings.get<string>(`legal.${kind}.content`),
      ]);
      return mode === "external" && url?.trim()
        ? { kind, mode: "external", value: url.trim() }
        : { kind, mode: "local", value: (content ?? "").trim() };
    };
    const documents = await Promise.all([document("terms"), document("privacy")]);
    const version = createHash("sha256").update(JSON.stringify(documents)).digest("hex");
    return { documents, version };
  },

  // Deliberately separate from ordinary session authentication. Callers must
  // never use this identity to authorize application data or issue credentials.
  pending: async (c: Context) => {
    const token = session.getToken(c);
    const claims = token ? await verifySessionToken(token) : null;
    if (!claims) return null;
    const { groupsAdmin } = await getIdentityRuntimeConfig();
    const user = await loadJwtSessionUser({
      userId: claims.sub,
      sid: claims.sid,
      authEpoch: claims.auth_epoch,
      groupsAdmin,
      allowPendingLegalConsent: true,
    });
    if (!user || isAccountExpired(user.accountExpires) || !(await isAccountCategoryAllowed(user))) return null;
    const [row] = await sql<{ pending: boolean }[]>`
      SELECT legal_pending AND NOT EXISTS (SELECT 1 FROM auth.legal_acceptances WHERE user_id = ${user.id}::uuid) AS pending
      FROM auth.session_families WHERE sid = ${claims.sid}::uuid
    `;
    return row?.pending ? { user, sid: claims.sid, authEpoch: claims.auth_epoch } : null;
  },

  accept: async (c: Context, version: string) => {
    const pending = await legalConsent.pending(c);
    if (!pending) throw new HTTPException(401, { message: "Sign in again to continue." });
    const current = await legalConsent.documents();
    if (current.version !== version) throw new HTTPException(409, { message: "The documents changed. Reload and review them again." });
    await sql.begin(async (tx) => {
      const [user] = await tx<{ provider: "local" | "ipa"; profile: "guest" | "user" }[]>`
        SELECT u.provider, u.profile FROM auth.users u JOIN auth.session_families sf ON sf.user_id = u.id
        JOIN auth.signing_keys sk ON sk.kid = sf.signing_kid AND sk.state <> 'revoked'
        WHERE u.id = ${pending.user.id}::uuid AND sf.sid = ${pending.sid}::uuid
          AND u.auth_epoch = ${pending.authEpoch} AND sf.auth_epoch = u.auth_epoch
          AND sf.revoked_at IS NULL AND sf.expires_at > now()
          AND (u.account_expires IS NULL OR u.account_expires > now())
        FOR UPDATE OF u, sf
      `;
      if (!user || !(await isAccountCategoryAllowed(user, tx))) throw new HTTPException(401, { message: "Sign in again to continue." });
      await tx`
        INSERT INTO auth.legal_acceptances (user_id, session_id, document_version, documents)
        VALUES (${pending.user.id}::uuid, ${pending.sid}::uuid, ${current.version}, ${JSON.stringify(current.documents)}::text::jsonb)
        ON CONFLICT (user_id) DO NOTHING
      `;
    });
  },
};
