import { type AuthContext, middleware } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import apiRoutes from "./api";
import { recentNotesWidgetHandler } from "./api/widgets";
import { notebooksCapabilities } from "./capabilities";
import { app } from "./config";
import pageRoutes, { adminPages as adminPageRoutes } from "./frontend";
import { notebookHelp } from "./help";
import { migrate } from "./migrate";
import { notebooksService, reindexRuntime, snapshotRuntime, yjsSnapshotWorker } from "./service";

const router = new Hono<AuthContext>()
  .use("*", middleware.runtime())
  .use("*", middleware.settings())
  .route("/api/notebooks", apiRoutes)
  .route("/app/notebooks", pageRoutes)
  .route("/admin/notebooks", adminPageRoutes);

const result = await app.start({
  capabilities: notebooksCapabilities,
  fetch: router.fetch,
  help: notebookHelp,
  openapi: apiRoutes,
  widgets: { recent: recentNotesWidgetHandler },
  lifecycle: {
    setup: async () => {
      await migrate();
    },
    start: async () => {
      yjsSnapshotWorker.start();
      try {
        await reindexRuntime.start();
        await snapshotRuntime.start();
      } catch (error) {
        await snapshotRuntime.stop();
        await reindexRuntime.stop();
        await yjsSnapshotWorker.stop();
        throw error;
      }
    },
    stop: async () => {
      await snapshotRuntime.stop();
      await reindexRuntime.stop();
      await yjsSnapshotWorker.stop();
    },
  },
});
export default { ...result, websocket };
export type { ApiType } from "./api";
export type {
  CreateNote,
  CreateNotebook,
  Note,
  Notebook,
  NoteTreeNode,
  NoteVersion,
  NoteWithContent,
  UpdateNote,
  UpdateNotebook,
} from "./service";
export { notebooksService as service };
