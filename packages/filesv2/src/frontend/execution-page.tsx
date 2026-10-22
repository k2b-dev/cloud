import { type AuthContext, getLocale, getTimeZone } from "@k2b/cloud/server";
import { logger } from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import { z } from "zod";
import { apiError, describeError } from "../api/api-error";
import { ssr } from "../config";
import { requestCall } from "../files-call";
import { filesService } from "../service";
import ExecutionDetails from "./ExecutionDetails";
import { executionMessages } from "./execution-messages";
import { executionUrl } from "./execution-url";
import { filesMessages } from "./messages";

const log = logger("filesv2:execution");

export default ssr<AuthContext>(async (c) => {
  const activityId = z.uuid().safeParse(c.req.param("activityId"));
  if (!activityId.success) return ssr.error(c, 404);
  const locale = getLocale(c);
  const { t } = executionMessages.resolve([locale]);
  const files = filesMessages.resolve([locale]).t.files;
  const timeZone = getTimeZone(c);
  try {
    const entry = await filesService.activityEntry({ ...requestCall(c), requestAbort: c.req.raw.signal }, { activityId: activityId.data });
    // A formerly full entry may now have only a disappearance projection. Do not recover stripped context.
    if (!entry.execution) return ssr.error(c, 404);
    return () => (
      <Layout c={c} title={[{ title: files, href: "/app/filesv2" }, { title: t.title }]}>
        <ExecutionDetails entry={entry} timeZone={timeZone} />
      </Layout>
    );
  } catch (error) {
    const { code, status } = apiError(error);
    if (status < 500) return ssr.error(c, status);
    log.error("Files execution record could not be loaded", { code, status, error: describeError(error) });
    return ssr.error(c, status, {
      title: t.failedTitle,
      description: t.failedText,
      action: { label: t.retry, href: executionUrl(activityId.data), icon: "ti ti-refresh" },
    });
  }
});
