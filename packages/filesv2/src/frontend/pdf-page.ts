import { type AuthContext, auth, getLocale } from "@k2b/cloud/server";
import { logger } from "@k2b/cloud/services";
import { Hono } from "hono";
import { apiError, describeError } from "../api/api-error";
import { inlinePdfResponse } from "../api/inline-pdf";
import { ssr } from "../config";
import { DownloadInputSchema } from "../contracts";
import { filesService } from "../service";
import { browserMessages } from "./browser-messages";
import { filesUrl } from "./urls";

const log = logger("filesv2:pdf");

/**
 * The address a browser tab opens for a stored PDF. It is a Files page: an expired session signs in
 * and returns here, and failures are localized pages. The last segment is the file name, which the
 * viewer shows as the title; every request reads the current file with current rights.
 */
export const pdfPage = new Hono<AuthContext>().get(
  "/app/filesv2/pdf/:baseId/:path{.+}",
  auth.requireRole("user", ssr.access),
  async (c) => {
    const baseId = c.req.param("baseId");
    const path = DownloadInputSchema.shape.path.safeParse(c.req.param("path"));
    if (!path.success) return ssr.error(c, 404);
    try {
      return inlinePdfResponse(await filesService.inlinePdf(c.get("actor"), { baseId, path: path.data }, c.req.raw.signal));
    } catch (error) {
      const { code, status } = apiError(error);
      if (status >= 500) log.error("Files PDF could not be opened", { code, status, error: describeError(error) });
      if (code !== "not_pdf") return ssr.error(c, status);
      const t = browserMessages.resolve([getLocale(c)]).t;
      return ssr.error(c, status, {
        title: t.notPdf,
        description: t.notPdfDescription,
        action: {
          label: t.showInFiles,
          href: filesUrl(baseId, path.data.split("/").slice(0, -1).join("/"), null, path.data),
          icon: "ti ti-folder",
        },
      });
    }
  },
);
