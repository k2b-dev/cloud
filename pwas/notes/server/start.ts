import { resolve } from "node:path";
import { env } from "@k2b/cloud/config";
import { SQL } from "bun";
import { migrate } from "./database";
import { appEnv } from "./env";
import { serveNotes } from "./runtime";

const startupCodes = new Set(["database_url_missing", "notes_schema_newer_than_server", "database_start_failed", "listener_start_failed"]);
export const startupCode = (error: unknown): string => {
  if (error instanceof Error && startupCodes.has(error.message)) return error.message;
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && /^[A-Z0-9]{5}$/.test(error.code))
    return `database_${error.code}`;
  return "startup_failed";
};

export const startNotes = async () => {
  if (!env.DATABASE_URL) throw new Error("database_url_missing");
  const db = new SQL(env.DATABASE_URL);
  try {
    await migrate(db);
  } catch (error) {
    await db.close();
    if (startupCode(error) !== "startup_failed") throw error;
    throw new Error("database_start_failed");
  }
  try {
    return await serveNotes(db, {
      origin: appEnv.NOTES_PUBLIC_ORIGIN,
      staticDirectory: resolve(import.meta.dir, "../dist"),

      adminPasswordHash: appEnv.NOTES_ADMIN_PASSWORD_HASH,
      trustedProxy: appEnv.NOTES_TRUSTED_PROXY,
      storageBytes: appEnv.NOTES_STORAGE_BYTES,
      maxConnections: appEnv.NOTES_MAX_CONNECTIONS,
      maxOpenPads: appEnv.NOTES_MAX_OPEN_PADS,
    });
  } catch (error) {
    await db.close();
    throw error;
  }
};

if (import.meta.main) {
  try {
    const runtime = await startNotes();
    const stop = () => {
      runtime.stop().catch(() => {
        console.error("[notes] shutdown_failed");
        process.exitCode = 1;
      });
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  } catch (error) {
    console.error(`[notes] ${startupCode(error)}`);
    process.exitCode = 1;
  }
}
