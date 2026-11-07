import { defineCapabilities, listApps } from "@k2b/cloud";
import {
  AppStatusDetailDataSchema,
  AppStatusDetailInputSchema,
  AppStatusForgetDataSchema,
  AppStatusForgetInputSchema,
  AppStatusSummaryDataSchema,
  AppStatusSummaryInputSchema,
  type CapabilityExecutionContext,
} from "@k2b/cloud/contracts";
import { err, fail, ok } from "@k2b/cloud/server";

const adminError = (context: CapabilityExecutionContext) => {
  const authority = context.authority;
  const user = authority?.actor.kind === "user" ? authority.actor.user : authority?.actor.delegatedUser;
  return authority && user?.roles.includes("admin") && authority.accessSubject.type === "user" && authority.accessSubject.userId === user.id
    ? null
    : fail(err.forbidden("Administrator access required"));
};
export const monitoringCapabilities = defineCapabilities({
  protocolVersion: 2,
  appStatus: { summary: "status.summary", detail: "status.detail", forget: "status.forget" },
  queries: {
    "status.summary": {
      title: "Read app traffic",
      description: "Return traffic for selected apps.",
      openWorld: false,
      input: AppStatusSummaryInputSchema,
      data: AppStatusSummaryDataSchema,
      run: async (input, context) =>
        adminError(context) ??
        ok({
          data: {
            apps: AppStatusSummaryInputSchema.parse(input).appIds.map((appId) => ({
              appId,
              traffic: null,
              links: [{ kind: "metrics", label: "Monitoring", href: "/admin/monitoring" }],
              lastSeenAt: null,
            })),
            otherApps: [],
          },
        }),
    },
    "status.detail": {
      title: "Read app failures",
      description: "Return route totals and one page of failed requests.",
      openWorld: false,
      input: AppStatusDetailInputSchema,
      data: AppStatusDetailDataSchema,
      run: async (_input, context) =>
        adminError(context) ?? ok({ data: { routes: [], failedRequests: [], nextCursor: null, totalFailedRequests: null } }),
    },
  },
  actions: {
    "status.forget": {
      title: "Forget app status",
      description: "Forget status records for an offline app.",
      input: AppStatusForgetInputSchema,
      data: AppStatusForgetDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "required",
      run: async ({ appId }, context) => {
        const denied = adminError(context);
        if (denied) return denied;
        const authority = context.authority;
        const kind = authority?.credentialKind === "invocation" ? authority.actor.delegation?.credentialKind : authority?.credentialKind;
        if (kind === "oauth" && !authority?.scopes.some((scope) => scope === "write" || scope === "admin"))
          return fail(err.forbidden("Write scope required"));
        if ((await listApps()).some((app) => app.id === appId)) return fail(err.badInput("Only offline apps can be forgotten"));
        return ok({ data: { forgotten: true } });
      },
    },
  },
});
