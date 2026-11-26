import { AccountDirectoryEntrySchema } from "@k2b/cloud/contracts";
import { type AuthContext, auth, getLocale, getTimeZone, jsonResponse, requiresAdmin, respond, v } from "@k2b/cloud/server";
import { accountsAppService as accountsService } from "@k2b/cloud/services";
import { ok } from "@k2b/stdlib";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { createPagination, ErrorResponseSchema, PaginationQuerySchema, PaginationResponseSchema, parsePagination } from "@/contracts";
import { directoryQueryOf, parseUsersAddress, usersQuery } from "@/frontend/users/query";
import { expectUserBackedActor, toAccountsActor } from "@/shared/actor";

const AccountsListResponseSchema = z.object({
  accounts: z.array(AccountDirectoryEntrySchema),
  pagination: PaginationResponseSchema,
});

/**
 * The administration's account list: people, agents and API key accounts, read from the same address as the list page
 * at /app/accounts/users. `GET /api/accounts/users` stays the list of people with the people's fields.
 */
const app = new Hono<AuthContext>().use(auth.requireRole("admin")).get(
  "/",
  describeRoute({
    tags: ["Users"],
    summary: "List accounts",
    description:
      "List people, agents and API key accounts with pagination, filters and sort, as the account list of Accounts reads its address. " +
      "kind=person,agent,api-key (agent: service accounts of the kind agent or standalone; api-key: resource-bound service accounts; personal keys and code accounts are never listed); " +
      "status=active,invited,expired,disabled (people are active, invited or expired; service accounts active or disabled); " +
      "duplicate=yes|no (people whose email address another account shares); q searches names and email addresses. " +
      "role, member-of, login, passkey and provider work as on GET /api/accounts/users and narrow the list to people. " +
      "sort=name.asc|name.desc|login.desc|login.asc|mail.asc|mail.desc; login is a person's last sign-in and a service " +
      "account's last API key use. Each entry carries its kind. A value the list cannot hold is refused with 400.",
    ...requiresAdmin,
    responses: {
      200: jsonResponse(AccountsListResponseSchema, "Paginated list of accounts"),
      400: jsonResponse(ErrorResponseSchema, "A filter value the list cannot hold"),
      401: jsonResponse(ErrorResponseSchema, "Authentication required"),
      403: jsonResponse(ErrorResponseSchema, "Admin access required"),
    },
  }),
  v(
    "query",
    z.object({
      ...PaginationQuerySchema.shape,
      q: z.string().optional(),
      kind: z.string().optional(),
      role: z.string().optional(),
      "member-of": z.string().optional(),
      status: z.string().optional(),
      login: z.string().optional(),
      passkey: z.enum(["yes", "no"]).optional(),
      provider: z.enum(["local", "ipa"]).optional(),
      duplicate: z.enum(["yes", "no"]).optional(),
      sort: z.string().optional(),
    }),
  ),
  async (c) => {
    const pagination = parsePagination(c.req.valid("query"));
    const params = new URL(c.req.url).searchParams;
    // The API pages with its own `page` and `per_page`; the list page's own page limit does not apply here.
    params.delete("per_page");
    params.delete("page");
    // The list arranges groups on its page; the API returns the accounts of the page and ignores the grouping.
    params.delete("group");
    const address = parseUsersAddress(usersQuery(getLocale(c)), params);
    const refused = address.issues.filter((issue) => issue.code !== "unknown");
    if (refused.length > 0)
      return c.json({ message: `Invalid list parameters: ${refused.map((issue) => issue.param || issue.code).join(", ")}` }, 400);

    const result = await accountsService.account.directory({
      actor: toAccountsActor(expectUserBackedActor(c)),
      ...directoryQueryOf(address.state, getTimeZone(c)),
      pagination: { page: pagination.page, perPage: pagination.perPage },
    });
    if (!result.ok) return respond(c, result);
    return respond(c, ok({ accounts: result.data.items, pagination: createPagination(pagination, result.data.total) }));
  },
);

export default app;
