import { accountCategory } from "@valentinkolb/cloud/contracts";
import { type AuthContext, auth, jsonResponse, requiresAuth, v } from "@valentinkolb/cloud/server";
import { accountsAppService, coreSettings } from "@valentinkolb/cloud/services";
import { AccountActionNoticeSchema, renderAccountActionNotice } from "@valentinkolb/cloud/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { describeRoute } from "hono-openapi";
import { z } from "zod";

/** Informational rendering, not mutation authorization or an audit assertion.
 * Deleted entities use the completed UI action's snapshot. */
export default new Hono<AuthContext>()
  .use(auth.requireRole("authenticated"))
  .use(auth.requireUser())
  // Fits every bounded context field even with six-byte JSON escapes.
  .use(bodyLimit({ maxSize: 32 * 1024, onError: (c) => c.json({ message: "Notice context is too large" }, 413) }))
  .post(
    "/",
    describeRoute({
      tags: ["Accounts"],
      summary: "Render an optional follow-up notice",
      description:
        "Renders operator-provided Markdown after a completed Accounts UI action. This endpoint does not perform or authorize the action. Administrators can render user and group notices; group managers can render group notices. Other authenticated callers receive an empty notice.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(
          z.object({ markdown: z.string().nullable(), failed: z.boolean() }),
          "Optional notice; rendering failures do not undo the completed action",
        ),
      },
    }),
    v("json", AccountActionNoticeSchema),
    async (c) => {
      c.header("Cache-Control", "no-store");
      const input = c.req.valid("json");
      const roles = c.get("user").roles;
      if (!roles.includes("admin") && !(input.action.startsWith("group.") && roles.includes("group-manager"))) {
        return c.json({ markdown: null, failed: false });
      }
      try {
        const template = await coreSettings.get<string>("user.action_notice");
        if (!template.trim()) return c.json({ markdown: null, failed: false });
        // Use canonical display data where the record still exists. Group
        // metadata is readable by full accounts; user detail requires admin.
        // Do not spread records: the template never receives credential fields.
        if (input.id && input.action.startsWith("group.")) {
          const group = await accountsAppService.group.get({ id: input.id });
          if (group) Object.assign(input, { name: group.name, provider: group.provider });
        } else if (input.id && roles.includes("admin")) {
          const user = await accountsAppService.user.get({ id: input.id });
          if (user)
            Object.assign(input, {
              uid: user.uid,
              name: user.uid,
              email: user.mail ?? "",
              firstName: user.givenname,
              lastName: user.sn,
              provider: user.provider,
              profile: user.profile,
              category: accountCategory(user),
            });
        }
        return c.json({ markdown: renderAccountActionNotice(template, input), failed: false });
      } catch {
        return c.json({ markdown: null, failed: true });
      }
    },
  );
