import { env } from "@k2b/cloud/config";
import { SQL } from "bun";
import { createNotesApp } from "./app";
import { databaseReady, migrate } from "./database";

export const startNotes = async () => {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const db = new SQL(env.DATABASE_URL);
  try {
    await migrate(db);
  } catch {
    await db.close();
    throw new Error("notes_database_start_failed");
  }
  let stopping = false;
  const app = createNotesApp(async () => !stopping && (await databaseReady(db)));
  const server = Bun.serve({ port: 3000, fetch: app.fetch });
  return {
    server,
    stop: async () => {
      if (stopping) return;
      stopping = true;
      await server.stop();
      await db.close();
    },
  };
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
  } catch {
    console.error("[notes] startup_failed");
    process.exitCode = 1;
  }
}
