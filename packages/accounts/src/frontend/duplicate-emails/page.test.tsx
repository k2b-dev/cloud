import { describe, expect, mock, test } from "bun:test";
import { DEFAULT_ACCOUNT_CATEGORY_POLICY } from "@k2b/cloud/contracts";
import { type Context, Hono } from "hono";
import type { JSX } from "solid-js";
import { renderToString } from "solid-js/web";

const target = {
  id: "local-id",
  uid: "ada",
  provider: "local",
  profile: "guest",
  givenname: "Ada",
  sn: "Lovelace",
  displayName: "Ada",
  mail: "ada@example.com",
  accountExpires: null,
  lastLoginLocal: null,
  lastLoginIpa: null,
  ipaSyncedAt: null,
};
const list = mock(async () => ({
  ok: true,
  data: {
    items: [
      {
        email: "ada@example.com",
        users: [
          target,
          {
            ...target,
            id: "ipa-id",
            uid: "ada-ipa",
            provider: "ipa",
            lastLoginLocal: "2026-09-08T10:00:00Z",
            lastLoginIpa: "2026-09-07T09:00:00Z",
            ipaSyncedAt: "2026-09-08T09:00:00Z",
          },
        ],
      },
    ],
    page: 1,
    perPage: 100,
    total: 1,
    hasNext: false,
  },
}));
mock.module("../../config", () => ({
  ssr: (handler: (c: Context) => Promise<Response | (() => JSX.Element)>) => [
    async (c: Context) => {
      const result = await handler(c);
      return result instanceof Response ? result : c.html(renderToString(result));
    },
  ],
}));
mock.module("@k2b/cloud/server", () => ({
  expectUserBackedActor: () => ({ id: "local-id", uid: "admin", roles: ["admin"], provider: "local" }),
  getLocale: () => "en",
}));
mock.module("@k2b/cloud/services", () => ({
  accountsAppService: { user: { listDuplicateEmails: list }, accountRequest: { list: async () => ({ total: 0 }) } },
  coreSettings: { get: async () => true },
  readAccountCategoryPolicy: async () => DEFAULT_ACCOUNT_CATEGORY_POLICY,
}));
mock.module("@k2b/cloud/ssr", () => ({ Layout: (props: { children: JSX.Element }) => props.children }));
mock.module("../AccountsWorkspace", () => ({ default: (props: { children: JSX.Element }) => props.children }));

const { default: page } = await import("./page");
const app = new Hono().get("/", ...page);

describe("duplicate email SSR page", () => {
  test("renders complete comparisons with distinct login labels and no fabricated missing timestamps", async () => {
    const response = await app.request("/");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Duplicate email addresses");
    expect(html).toContain("Last web login");
    expect(html).toContain("Last Kerberos login");
    expect(html).toContain("Not recorded");
    expect(html).toContain("UTC");
    expect(html).toContain("ada-ipa");
    expect(html).toContain("/app/accounts/users/ipa-id");
    expect(html).toContain("You cannot delete your own account.");
  });
  test("renders the empty state when all duplicate addresses are resolved", async () => {
    const snapshot = await list();
    list.mockResolvedValueOnce({ ...snapshot, data: { ...snapshot.data, items: [], total: 0 } });
    const response = await app.request("/");
    const html = await response.text();
    expect(html).toContain("No duplicate email addresses remain.");
    expect(html).not.toContain("Delete account");
  });

  test("redirects to the remaining page after its last group is removed", async () => {
    const response = await app.request("/?page=2");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/app/accounts/duplicate-emails?page=1");
  });
});
