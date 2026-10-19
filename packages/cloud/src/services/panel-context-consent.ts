import { type SQL, sql } from "bun";
import { CapabilityAppIdSchema } from "../contracts/capabilities";

type ConsentAnswer = { allowed: boolean; revision: number };
export class PanelConsentCancelled extends Error {
  constructor() {
    super("The request was cancelled before the panel consent was saved");
  }
}

/**
 * Core owns the table; platform requests read without a process-wide cache. Missing is distinct from denied. Reads
 * take a share lock, so a page rendered while a save is in flight sees that save's outcome, not the answer before it.
 */
export const createPanelContextConsentService = (db: SQL = sql) => ({
  async get(userId: string, provider: string): Promise<ConsentAnswer | null> {
    CapabilityAppIdSchema.parse(provider);
    const [row] = await db<ConsentAnswer[]>`
      SELECT allowed, revision FROM auth.panel_context_consent WHERE user_id = ${userId}::uuid AND provider = ${provider}
      FOR SHARE
    `;
    return row ?? null;
  },
  async list(userId: string, providers: string[]): Promise<Record<string, ConsentAnswer>> {
    if (!providers.length) return {};
    for (const provider of providers) CapabilityAppIdSchema.parse(provider);
    const rows = await db<({ provider: string } & ConsentAnswer)[]>`
      SELECT provider, allowed, revision FROM auth.panel_context_consent
      WHERE user_id = ${userId}::uuid AND provider IN ${db(providers)}
      FOR SHARE
    `;
    return Object.fromEntries(rows.map(({ provider, allowed, revision }) => [provider, { allowed, revision }]));
  },
  /**
   * Compare-and-set on the revision the client read. A save whose request was cancelled (the browser gave up or
   * left) is rolled back before commit, so no answer lands after its page stopped waiting.
   */
  async set(userId: string, provider: string, allowed: boolean, revision: number, signal?: AbortSignal): Promise<ConsentAnswer | null> {
    CapabilityAppIdSchema.parse(provider);
    return db.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = '5s'`;
      const [row] = await tx<ConsentAnswer[]>`
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
      if (signal?.aborted) throw new PanelConsentCancelled();
      return row ?? null;
    });
  },
});
export const panelContextConsent = createPanelContextConsentService();
