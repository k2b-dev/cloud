import { logger } from "@k2b/cloud/services";
import { sql } from "bun";
import { z } from "zod";

const log = logger("chat:api");

export const ChatHealthSchema = z.object({
  /** `ok` when the database answers and the chat schema exists; the admin page and operators read this first. */
  status: z.enum(["ok", "unavailable"]),
  observedAt: z.string(),
  database: z.object({
    status: z.enum(["ok", "unavailable"]),
    /** Round trip of the probe query in milliseconds; `null` when the database did not answer. */
    latencyMs: z.number().nullable(),
  }),
});
export type ChatHealth = z.infer<typeof ChatHealthSchema>;

/**
 * Operational state of the chat app for `/admin/chat` and `GET /api/chat/admin/health`.
 * Later slices add their own rows (outbox backlog, delivery and push jobs, storage)
 * to this one snapshot instead of separate endpoints.
 */
const health = async (): Promise<ChatHealth> => {
  const started = performance.now();
  let ready = false;
  try {
    const [row] = await sql<{ ready: boolean }[]>`SELECT to_regnamespace('chat') IS NOT NULL AS ready`;
    ready = row?.ready === true;
  } catch (error) {
    log.warn("Chat health probe could not reach the database", { error: error instanceof Error ? error.message : String(error) });
    return { status: "unavailable", observedAt: new Date().toISOString(), database: { status: "unavailable", latencyMs: null } };
  }
  const latencyMs = Math.round(performance.now() - started);
  const status = ready ? "ok" : "unavailable";
  return { status, observedAt: new Date().toISOString(), database: { status, latencyMs } };
};

export const chatService = { health };
export type ChatService = typeof chatService;
