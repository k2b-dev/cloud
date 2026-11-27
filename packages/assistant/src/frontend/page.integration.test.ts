import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "@k2b/cloud";
import * as ai from "@k2b/cloud/ai";
import * as live from "@k2b/cloud/ai/live";
import * as capabilityServer from "@k2b/cloud/capabilities/server";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as rail from "@k2b/cloud/services/rail-snapshot";
import { Hono } from "hono";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { databaseSuite, useMigratedDatabase } from "../../../../scripts/fixtures/test-infra";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";

// The statements one server load of Gustav's page costs, against a migrated database: the first view of an open chat
// is read in one go (the sidebar's bounded page, the chat, its timeline and context, its tabs), never per row. Core's
// Code queries go through capabilities (no SQL of Gustav's), the shell's rail and the live cursor are not the page's.
const root = mkdtempSync(join(tmpdir(), "assistant-page-integration-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: handler } = await import("./page");

const suite = databaseSuite();
const spies: { mockRestore(): void }[] = [];

suite("Gustav's page on the server", () => {
  let user: User;
  let open = "";

  beforeAll(async () => {
    await useMigratedDatabase("assistant_page");
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
      VALUES ('page-reader', 'local', 'user', 'Page Reader', 'page-reader@example.test', 'Page', 'Reader')
      RETURNING id
    `;
    user = {
      id: row!.id,
      uid: "page-reader",
      roles: ["user"],
      provider: "local",
      profile: "user",
      givenname: "Page",
      sn: "Reader",
      displayName: "Page Reader",
      mail: "page-reader@example.test",
      avatarHash: null,
      ipa: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
    };
    // More open chats than one page of the sidebar holds, so the bound shows in the count too.
    for (let n = 1; n <= 120; n++) {
      const chat = await ai.aiConversations.createConversation({ ownerUserId: user.id, title: `Chat ${n}` });
      if (n === 120) open = chat.shortId;
    }
    spies.push(
      spyOn(capabilityServer, "invokeCapabilityWithDataSchema").mockImplementation(async (invocation, schema) => {
        // Empty answers: a Code page, or the open questions (`ai.open_questions`, a count beside its items).
        for (const empty of [
          { items: [], nextCursor: null },
          { items: [], count: 0 },
        ]) {
          const parsed = schema.safeParse(empty);
          if (parsed.success) return { ok: true, data: { data: parsed.data } };
        }
        throw new Error(`no empty answer fits ${invocation.capabilityId}`);
      }),
      spyOn(rail, "readRailSnapshot").mockResolvedValue({
        revision: 0,
        visibility: {},
        shortcuts: [],
        showNames: true,
        managedShortcuts: [],
      }),
      spyOn(live.aiLive, "cursor").mockResolvedValue("s6t.cloud-live-core.0"),
    );
  }, 120_000);
  afterAll(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  const request = (href: string) => {
    const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
    app.use("*", async (c, next) => {
      c.set("actor", { kind: "user", user, sessionKind: "app" });
      c.set("accessSubject", { type: "user", userId: user.id });
      c.set("credentialKind", "session");
      c.set("credentialScopes", []);
      c.set("user", user);
      c.set("runtime", { apps: [] });
      await next();
    });
    app.get("/app/assistant", ...handler);
    return app.request(href);
  };

  test("an open chat's first view costs a fixed number of statements, whatever the number of chats", async () => {
    // Warm the module and cache reads once, so the count is the page's own per request.
    expect((await request(`https://cloud.example.test/app/assistant?conversation=${open}`)).status).toBe(200);
    const meter = await meterSql();
    let statements: string[] = [];
    let html = "";
    try {
      statements = await meter.during(async () => {
        const response = await request(`https://cloud.example.test/app/assistant?conversation=${open}`);
        expect(response.status).toBe(200);
        html = await response.text();
      });
    } finally {
      await meter.close();
    }
    // What the island carries to the browser: its props, as the page writes them.
    const props = [...html.matchAll(/data-props="([^"]*)"/g)].reduce((sum, match) => sum + (match[1]?.length ?? 0), 0);
    console.info(`assistant page: ${statements.length} statements, island props ${props} B\n${statements.join("\n")}`);
    expect(statements.length).toBeLessThanOrEqual(STATEMENTS);
    expect(props).toBeLessThanOrEqual(PROPS_BYTES);
  }, 60_000);
});

/**
 * Measured on the test VM (27.11.): 61 statements. About half are `@k2b/cloud/ai` reading its model configuration once
 * per function that needs it (no read per request), the rest the first view; none is read per chat. A new statement on
 * this path shows here first.
 */
const STATEMENTS = 61;
/** The island's props for that view, measured with it; the sidebar's bounded page is most of it. */
const PROPS_BYTES = 248_000;
