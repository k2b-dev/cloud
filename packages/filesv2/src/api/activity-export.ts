import {
  type AuthContext,
  getLocale,
  middleware,
  REQUEST_IDLE_TIMEOUT_MAX_SECONDS,
  REQUEST_IDLE_TIMEOUT_SECONDS,
  requiresAdmin,
  setRequestTimeout,
  v,
} from "@k2b/cloud/server";
import { AccountIdentityError, logger } from "@k2b/cloud/services";
import { Hono } from "hono";
import { ActivityExportError, ActivityExportInput } from "../activity-export-contracts";
import { requestCall } from "../files-call";
import type { createActivityExportService } from "../service/activity-export";
import { FilesError } from "../service/errors";
import { errorMessage } from "./messages";

const log = logger("filesv2:activity-export-api");

/** Parent mounts this below its authenticated API; domain authorization is always in the service. */
export function createActivityExportApi(service: ReturnType<typeof createActivityExportService>) {
  return new Hono<AuthContext>()
    .use("/admin/activity/export", middleware.noTransform())
    .get(
      "/admin/activity/export/preview",
      middleware.openapi({ summary: "Count matching history before an administrative export", ...requiresAdmin }),
      v("query", ActivityExportInput),
      async (c) => {
        setRequestTimeout(c, REQUEST_IDLE_TIMEOUT_MAX_SECONDS);
        c.header("Cache-Control", "no-store");
        try {
          return c.json(await service.preview(requestCall(c), c.req.valid("query"), c.req.raw.signal));
        } catch (error) {
          const known = error instanceof ActivityExportError || error instanceof FilesError || error instanceof AccountIdentityError;
          const code = known ? error.code : "activity_export_failed";
          const status = known ? error.status : 503;
          if (!known) log.error("History export preview failed", { code });
          return c.json({ ok: false, code, error: errorMessage(code, getLocale(c)) }, status);
        } finally {
          setRequestTimeout(c, REQUEST_IDLE_TIMEOUT_SECONDS);
        }
      },
    )
    .get(
      "/admin/activity/export",
      middleware.openapi({ summary: "Export file history across bases as an administrator", ...requiresAdmin }),
      v("query", ActivityExportInput),
      async (c) => {
        setRequestTimeout(c, REQUEST_IDLE_TIMEOUT_MAX_SECONDS);
        try {
          const result = await service.export(requestCall(c), c.req.valid("query"), c.req.raw.signal);
          return new Response(result.stream, {
            headers: {
              "Content-Type": result.format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8",
              "Content-Disposition": `attachment; filename="files-activity.${result.format}"`,
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
            },
          });
        } catch (error) {
          if (error instanceof ActivityExportError)
            return c.json(
              {
                ok: false,
                code: error.code,
                error: errorMessage(error.code, getLocale(c)),
                remedy: error.status === 413 ? "narrow_date_range" : "retry",
              },
              error.status,
            );
          if (error instanceof FilesError || error instanceof AccountIdentityError)
            return c.json({ ok: false, code: error.code, error: errorMessage(error.code, getLocale(c)) }, error.status);
          log.error("History export preparation failed", { code: "activity_export_failed" });
          return c.json(
            { ok: false, code: "activity_export_failed", error: errorMessage("activity_export_failed", getLocale(c)), remedy: "retry" },
            503,
          );
        } finally {
          setRequestTimeout(c, REQUEST_IDLE_TIMEOUT_SECONDS);
        }
      },
    );
}
