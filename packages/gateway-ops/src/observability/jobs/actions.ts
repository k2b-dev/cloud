import type { AuthContext } from "@k2b/cloud/server";
import type { Context } from "hono";
import { syncOpsCredentials } from "../sync/service";
import { jobsObservabilityService } from "./service";

const baseUrl = "/admin/observability/jobs";

const field = (body: Record<string, FormDataEntryValue>, key: string): string => {
  const value = body[key];
  return typeof value === "string" ? value : "";
};

const safeRedirect = (value: string): string => {
  if (!value.startsWith("/") || value.startsWith("//")) return baseUrl;
  try {
    const parsed = new URL(value, "http://cloud.local");
    if (parsed.origin !== "http://cloud.local") return baseUrl;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return baseUrl;
  }
};

const withFeedback = (target: string, status: "accepted" | "error", message: string): string => {
  const url = new URL(target, "http://cloud.local");
  url.searchParams.set("job_action", status);
  url.searchParams.set("job_message", message);
  return `${url.pathname}${url.search}`;
};

export const runScheduleNowAction = async (c: Context<AuthContext>) => {
  const body = (await c.req.parseBody()) as Record<string, FormDataEntryValue>;
  const redirectTo = safeRedirect(field(body, "redirectTo"));
  const schedulerId = field(body, "schedulerId");
  const scheduleId = field(body, "scheduleId");

  const result = await jobsObservabilityService.runScheduleNow(
    {
      appId: field(body, "appId"),
      schedulerId,
      scheduleId,
      requestId: crypto.randomUUID(),
    },
    syncOpsCredentials(c.req.raw),
  );

  if (!result.ok) {
    return c.redirect(withFeedback(redirectTo, "error", result.error.message), 303);
  }

  return c.redirect(withFeedback(redirectTo, "accepted", `Run request accepted for ${result.data.scheduleId}.`), 303);
};
