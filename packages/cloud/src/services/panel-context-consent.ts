import { type SQL, sql } from "bun";
import { CapabilityAppIdSchema } from "../contracts/capabilities";

type ConsentAnswer = { allowed: boolean; revision: number };

/** Core owns the table; platform requests read without a process-wide cache. Missing is distinct from denied. */
export const createPanelContextConsentService = (db: SQL = sql) => ({
  async get(userId: string, provider: string): Promise<ConsentAnswer | null> {
    CapabilityAppIdSchema.parse(provider);
    const [row] = await db<ConsentAnswer[]>`
      SELECT allowed, revision FROM auth.panel_context_consent WHERE user_id = ${userId}::uuid AND provider = ${provider}
    `;
    return row ?? null;
  },
  async list(userId: string, providers: string[]): Promise<Record<string, ConsentAnswer>> {
    if (!providers.length) return {};
    for (const provider of providers) CapabilityAppIdSchema.parse(provider);
    const rows = await db<({ provider: string } & ConsentAnswer)[]>`
      SELECT provider, allowed, revision FROM auth.panel_context_consent
      WHERE user_id = ${userId}::uuid AND provider IN ${db(providers)}
    `;
    return Object.fromEntries(rows.map(({ provider, allowed, revision }) => [provider, { allowed, revision }]));
  },
  async set(userId: string, provider: string, allowed: boolean, revision: number): Promise<ConsentAnswer | null> {
    CapabilityAppIdSchema.parse(provider);
    const [row] = await db<ConsentAnswer[]>`
      INSERT INTO auth.panel_context_consent (user_id, provider, allowed, revision)
      SELECT ${userId}::uuid, ${provider}, ${allowed}, 1
      WHERE ${revision} = 0 OR EXISTS (
        SELECT 1 FROM auth.panel_context_consent WHERE user_id = ${userId}::uuid AND provider = ${provider}
      )
      ON CONFLICT (user_id, provider) DO UPDATE SET
        allowed = EXCLUDED.allowed, revision = auth.panel_context_consent.revision + 1, updated_at = now()
      WHERE auth.panel_context_consent.revision = ${revision}
      RETURNING allowed, revision
    `;
    return row ?? null;
  },
});
export const panelContextConsent = createPanelContextConsentService();
