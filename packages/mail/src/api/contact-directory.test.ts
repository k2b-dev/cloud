import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import * as platformServices from "@k2b/cloud/services";
import { oauthTokens } from "@k2b/cloud/services";
import { redis } from "bun";
import { Hono } from "hono";
import { contactDirectory, conversationContext, publicResources } from "../service";
import api from ".";

const user = (roles: User["roles"]) =>
  ({
    id: "11111111-1111-4111-8111-111111111111",
    uid: "contact-directory-test",
    roles,
    provider: "local",
    profile: "user",
    givenname: "Contact",
    sn: "Directory",
    displayName: "Contact Directory",
    mail: "contact-directory@example.test",
    avatarHash: null,
    ipa: null,
    accountExpires: null,
    lastLoginLocal: null,
    memberofGroup: [],
    memberofGroupIds: [],
    manages: [],
    managesGroupIds: [],
  }) satisfies User;

const crmSettings = {
  mail: {
    contact_directory: {
      app: "crm",
      suggest: "customer.suggest",
      resolve: "customer.match",
      read: "",
      list_writable_books: "",
      create: "",
    },
  },
};

// Stands in for middleware.settings(): the route reads the stored mapping from the request snapshot.
const withSettings = (settings: unknown) =>
  new Hono<{ Variables: { settings: unknown } }>()
    .use(async (c, next) => {
      c.set("settings", settings);
      await next();
    })
    .route("/", api);

const headers = { authorization: "Bearer contact-directory-test" };

afterEach(() => mock.restore());

beforeEach(() => {
  spyOn(platformServices, "get").mockResolvedValue(100);
  spyOn(redis, "send").mockImplementation(async (command) => {
    if (command !== "EVAL") throw new Error(`Unexpected Redis command: ${command}`);
    return [1, 0, "1"];
  });
});

describe("Mail contact directory routes", () => {
  test("resolve conversation participants through the configured directory", async () => {
    spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", payload: {}, user: user(["user"]), scopes: [] });
    spyOn(publicResources, "resolvePublicId").mockResolvedValue("22222222-2222-4222-8222-222222222222");
    spyOn(publicResources, "resolveMailboxPublicId").mockResolvedValue("33333333-3333-4333-8333-333333333333");
    spyOn(publicResources, "publicIds").mockResolvedValue(new Map([["33333333-3333-4333-8333-333333333333", "cnv123"]]));
    const context = spyOn(conversationContext, "getConversationContext").mockResolvedValue({
      ok: true,
      data: {
        conversationId: "33333333-3333-4333-8333-333333333333",
        participants: [],
        contacts: { status: "unavailable", items: [], matchedEmails: [], nextCursor: null },
        spaces: { status: "unavailable", items: [], truncated: false },
      },
    });

    const response = await withSettings(crmSettings).request("/mailboxes/mbx123/conversations/cnv123/context", { headers });

    expect(response.status).toBe(200);
    expect(context.mock.calls[0]?.[0].contactDirectory).toEqual({
      suggest: { appId: "crm", capabilityId: "customer.suggest" },
      resolve: { appId: "crm", capabilityId: "customer.match" },
      read: null,
      listWritableBooks: null,
      create: null,
    });
  });

  test("returns field-level issues when an administrator saves an unusable mapping", async () => {
    spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", payload: {}, user: user(["admin", "user"]), scopes: [] });
    const issue = { field: "suggest" as const, code: "data_mismatch" as const, message: "Suggest does not match." };
    const save = spyOn(contactDirectory, "saveContactDirectory").mockResolvedValue({ ok: false, status: 400, issues: [issue] });
    const mapping = {
      appId: "crm",
      suggest: "customer.search",
      resolve: "customer.match",
      read: "",
      listWritableBooks: "",
      create: "",
    };

    const response = await api.request("/admin/contact-directory", {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json", "accept-language": "de" },
      body: JSON.stringify(mapping),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      message: "Mail kann diese Zuordnung noch nicht verwenden.",
      code: "CONTACT_DIRECTORY_INVALID",
      issues: [issue],
    });
    expect(save.mock.calls[0]?.[1]).toEqual(mapping);
  });

  test("shows the stored mapping with compatible capabilities to administrators", async () => {
    spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", payload: {}, user: user(["admin", "user"]), scopes: [] });
    const view = {
      config: { appId: "crm", suggest: "customer.suggest", resolve: "customer.match", read: "", listWritableBooks: "", create: "" },
      apps: null,
      issues: [],
    };
    const load = spyOn(contactDirectory, "loadContactDirectoryAdmin").mockResolvedValue({ ok: true, data: view });

    const response = await withSettings(crmSettings).request("/admin/contact-directory", { headers });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(view);
    expect(load.mock.calls[0]?.[1]).toEqual(view.config);
  });

  test("keeps the contact directory view for administrators", async () => {
    spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", payload: {}, user: user(["user"]), scopes: [] });
    const load = spyOn(contactDirectory, "loadContactDirectoryAdmin");

    const response = await api.request("/admin/contact-directory", { headers });

    expect(response.status).toBe(403);
    expect(load).not.toHaveBeenCalled();
  });

  test("keeps the save route for administrators", async () => {
    spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", payload: {}, user: user(["user"]), scopes: [] });
    const save = spyOn(contactDirectory, "saveContactDirectory");

    const response = await api.request("/admin/contact-directory", {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ appId: "crm", suggest: "", resolve: "", read: "", listWritableBooks: "", create: "" }),
    });

    expect(response.status).toBe(403);
    expect(save).not.toHaveBeenCalled();
  });
});
