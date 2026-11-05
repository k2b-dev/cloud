import { expect, test } from "bun:test";
import assistant from "../packages/assistant/src/cli";
import type { CloudCliContext } from "../packages/cloud/src/cli";
import contacts from "../packages/contacts/src/cli";
import grids from "../packages/grids/src/cli";
import mail from "../packages/mail/src/cli";
import notebooks from "../packages/notebooks/src/cli";
import pulse from "../packages/pulse/src/cli";
import spaces from "../packages/spaces/src/cli";
import venue from "../packages/venue/src/cli";

const id = "Rs2345",
  account = "11111111-1111-4111-8111-111111111111",
  handle = "code-7k2q9m4xwt";
const item = { id, shortId: id, name: "Resource", slug: "resource", permission: "admin" };
for (const [name, module, args, type] of [
  ["spaces", spaces, ["access", "grant", "Resource"], "spaces.space"],
  ["mail", mail, ["access", "grant", "Resource"], "mail.mailbox"],
  ["mail admin", mail, ["admin", "mailbox", "access", "grant", "Resource"], "mail.mailbox"],
  ["contacts", contacts, ["access", "grant", "Resource"], "contacts.book"],
  ["notebooks", notebooks, ["access", "grant", "Resource"], "notebooks.notebook"],
  ["pulse", pulse, ["access", "grant", "Resource"], "pulse.base"],
  ["venue", venue, ["access", "grant", "Resource"], "venue.venue"],
  ["grids base", grids, ["access", "grant", "base", "Resource"], "grids.base"],
  ["grids app", grids, ["access", "grant", "app", "Resource", "Resource"], "grids.base"],
  ["projects", assistant, ["projects", "access", "grant", "Resource"], "core.ai.project"],
  ["skills", assistant, ["skills", "access", "grant", "Resource"], "core.ai.skill"],
] as const) {
  test(`${name} shares with a Code handle through targeted principal resolution`, async () => {
    let lookup: URL | undefined, granted: unknown;
    const ctx: CloudCliContext = {
      args: [...args],
      flags: { "service-account": handle, permission: "read" },
      options: { profile: "test", server: "https://cloud.example", token: "test", output: "json" },
      getDefault: async () => undefined,
      setDefault: async () => {},
      createApiClient: () => {
        throw new Error("unused");
      },
      fetch: async (path, init) => {
        const url = new URL(path, "https://cloud.example");
        if (url.pathname === "/api/accounts/entities") {
          lookup = url;
          return Response.json({
            items: [{ kind: "service_account", serviceAccount: { id: account, handle, name: "Code of Resource", kind: "code" } }],
          });
        }
        if (init?.method === "POST") {
          granted = JSON.parse(String(init.body));
          return Response.json({
            access: { id: "Ac2345" },
            accessId: "Ac2345",
            id: "Ac2345",
            principal: { type: "service_account", serviceAccountId: account },
            permission: "read",
          });
        }
        if (url.pathname.endsWith("/resolve")) return Response.json({ book: item, base: item, space: item, mailbox: item });
        if (url.pathname.endsWith("/admin/operations"))
          return Response.json({ mailboxes: [{ mailboxId: id, mailboxName: "Resource" }], nextCursor: null });
        if (url.pathname === "/api/pulse/bases") return Response.json([item]);
        if (url.pathname.includes("/apps")) return Response.json([{ ...item, id: "Ap2345", shortId: "Ap2345" }]);
        if (url.pathname.endsWith("/access")) return Response.json({ access: [], entries: [] });
        return Response.json({ ...item, data: [item], venues: [item], projects: [item], skills: [item], skill: item, items: [item] });
      },
      readJson: async (response) => response.json(),
      print: () => {},
      write: async () => {},
      error: () => {},
      json: () => {},
      jsonLine: () => {},
      table: () => {},
    };
    await module.run(ctx);
    expect(lookup?.searchParams.get("target_type")).toBe(type);
    expect(lookup?.searchParams.get("target_id")).toBe(id);
    expect(lookup?.searchParams.get("search")).toBe(handle);
    expect(granted).toMatchObject({ principal: { type: "service_account", serviceAccountId: account }, permission: "read" });
  });
}
