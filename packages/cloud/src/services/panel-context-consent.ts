import { type SQL, sql } from "bun";
import { CapabilityAppIdSchema } from "../contracts/capabilities";

/** Core owns the table; platform requests read without a process-wide cache. Missing is distinct from denied. */
export const createPanelContextConsentService = (db: SQL = sql) => ({
  async get(userId: string, provider: string): Promise<boolean | null> {
    CapabilityAppIdSchema.parse(provider);
    const [row] = await db<{ allowed: boolean }[]>`
      SELECT allowed FROM auth.panel_context_consent WHERE user_id = ${userId}::uuid AND provider = ${provider}
    `;
    return row?.allowed ?? null;
  },
  async list(userId: string, providers: string[]): Promise<Record<string, boolean>> {
    if (!providers.length) return {};
    for (const provider of providers) CapabilityAppIdSchema.parse(provider);
    const rows = await db<{ provider: string; allowed: boolean }[]>`
      SELECT provider, allowed FROM auth.panel_context_consent
      WHERE user_id = ${userId}::uuid AND provider IN ${db(providers)}
    `;
    return Object.fromEntries(rows.map((row) => [row.provider, row.allowed]));
  },
  async set(userId: string, provider: string, allowed: boolean): Promise<boolean> {
    CapabilityAppIdSchema.parse(provider);
    const [row] = await db<{ allowed: boolean }[]>`
      INSERT INTO auth.panel_context_consent (user_id, provider, allowed)
      VALUES (${userId}::uuid, ${provider}, ${allowed})
      ON CONFLICT (user_id, provider) DO UPDATE SET allowed = EXCLUDED.allowed, updated_at = now()
      RETURNING allowed
    `;
    if (!row) throw new Error("Panel consent was not saved");
    return row.allowed;
  },
});
export const panelContextConsent = createPanelContextConsentService();
