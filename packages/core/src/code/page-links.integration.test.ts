import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "@k2b/cloud";
import { aiConversations } from "@k2b/cloud/ai";
import { aiLive } from "@k2b/cloud/ai/live";
import * as capabilities from "@k2b/cloud/capabilities/server";
import { type CapabilityExecutionContext, CodePageLinksSchema, capabilityResultSchema, type User } from "@k2b/cloud/contracts";
import type { RequestAuthority } from "@k2b/cloud/server";
import { accounts } from "@k2b/cloud/services";
import { Hono } from "hono";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { z } from "zod";
import { compileCapabilities, invokeCompiledCapability } from "../../../../scripts/fixtures/code-platform";
import { suiteFor, useMigratedDatabase } from "../../../../scripts/fixtures/test-infra";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import { aiCapabilities } from "../capabilities";
import { previewCodeActivation } from "./activation";
import { loadCodeChatPages, projectCodeChatPages } from "./chat-pages";
import { chatPageManifest } from "./chat-pages.test-fixture";
import { CODE_SETTINGS, codeSettings } from "./settings";
import { readCodeVersion } from "./store";

registerSsrTestPlugin({ dev: true, rootDir: mkdtempSync(join(tmpdir(), "cloud-gl-render-")) });
const [{ loadCodePage }, { default: CodePage }, { LocaleProvider }] = await Promise.all([
  import("@k2b/cloud/ssr"),
  import("@k2b/cloud/ssr/code-page"),
  import("@k2b/ui"),
]);
const memberId = "ab000000-0000-4000-8000-000000000001";
const guestId = "ab000000-0000-4000-8000-000000000002";
const compiled = compileCapabilities("core", aiCapabilities);
const fixed = new Date("2026-11-17T10:00:00Z");

function authority(user: User, delegated = false): RequestAuthority {
  return {
    actor: { kind: "user", user },
    accessSubject: { type: "user", userId: user.id },
    credentialKind: delegated ? "invocation" : "session",
    scopes: delegated ? ["core:read"] : [],
  };
}
function execution(user: User, delegated = false): CapabilityExecutionContext {
  const auth = authority(user, delegated);
  return {
    authority: auth,
    actor: auth.actor,
    accessSubject: auth.accessSubject,
    user,
    locale: "de",
    requestId: "page-viewer-fixture",
    origin: "http",
    signal: AbortSignal.timeout(10000),
  };
}

suiteFor(
  "database",
  "nats",
  "valkey",
)("page links across the public read paths", () => {
  let database: Awaited<ReturnType<typeof useMigratedDatabase>>;
  let member: User, guest: User;
  let settings: ReturnType<typeof spyOn<typeof codeSettings, "get">>;
  let ordinal = 0;
  beforeAll(async () => {
    setSystemTime(fixed);
    database = await useMigratedDatabase("code_page_viewers");
    // No app.start() registers Core settings in this service fixture.
    settings = spyOn(codeSettings, "get").mockImplementation(async (key) => CODE_SETTINGS[key].default);
    await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES
      (${memberId}::uuid,'page-member','local','user'),(${guestId}::uuid,'page-guest','local','guest')`;
    const users = await Promise.all([accounts.users.get({ id: memberId }), accounts.users.get({ id: guestId })]);
    if (!users[0] || !users[1]) throw new Error("Missing viewer fixtures");
    [member, guest] = [users[0], users[1]];
  });
  afterAll(async () => {
    setSystemTime();
    settings?.mockRestore();
    await database?.drop();
  });
  async function fixture(person: User, grant: "owner" | "editor" | "reader") {
    const codeId = `c_viewer${++ordinal}`;
    const versionId = `ab000000-0000-4000-8001-${String(ordinal).padStart(12, "0")}`;
    const chat = await aiConversations.createConversation({ ownerUserId: person.id, title: "Fictional page chat" });
    await sql`INSERT INTO code.codes(id,owner_kind,owner_user_id,title,created_by,chat_conversation_id)
      VALUES(${codeId},'person',${grant === "owner" ? person.id : memberId}::uuid,'Fictional page',${memberId}::uuid,${chat.id}::uuid)`;
    await sql`INSERT INTO code.versions(id,code_id,number,source_files,bundle,source_hash,bundle_hash,manifest,source_bytes,bundle_bytes,created_by)
      VALUES(${versionId}::uuid,${codeId},1,'{"code.ts":"fixture"}','fixture',${"a".repeat(64)},${"b".repeat(64)},
        ${JSON.stringify(chatPageManifest)}::text::jsonb,7,7,${memberId}::uuid)`;
    await sql`UPDATE code.codes SET state='active',active_version_id=${versionId}::uuid WHERE id=${codeId}`;
    if (grant !== "owner") {
      await sql`WITH share AS (INSERT INTO auth.access(user_id,permission) VALUES(${person.id}::uuid,${grant === "editor" ? "write" : "read"}) RETURNING id)
        INSERT INTO code.shares(code_id,access_id) SELECT ${codeId},id FROM share`;
    }
    return { codeId, versionId, conversationId: chat.id };
  }
  const input = ({ codeId, versionId }: { codeId: string; versionId: string }) => ({
    codeId,
    versionId,
    content: { kind: "manifest" as const },
    offset: 0,
    length: 32000,
  });
  async function ssr(f: { codeId: string }, person: User) {
    const calls: string[] = [];
    const failures: { capabilityId: string; error: unknown }[] = [];
    // Only transport is replaced: every Core query executes its compiled definition and service against the database.
    const invoke = spyOn(capabilities, "invokeCapabilityWithDataSchema").mockImplementation(async (invocation, schema) => {
      calls.push(invocation.capabilityId);
      if (invocation.appId !== "core") throw new Error("Unexpected foreign page read");
      const result = await invokeCompiledCapability({
        compiled,
        kind: "query",
        localId: invocation.capabilityId,
        input: invocation.input,
        // Mirror the transport's catalog handshake before running the real query.
        expectedSchemaHash: compiled.queries.get(invocation.capabilityId)!.manifest.schemaHash,
        context: execution(person, true),
        onUnexpectedError: (error) => failures.push({ capabilityId: invocation.capabilityId, error: String(error) }),
      });
      if (!result.ok) failures.push({ capabilityId: invocation.capabilityId, error: result.error });
      return result.ok ? { ok: true, data: capabilityResultSchema(schema).parse(result.data) } : result;
    });
    const cursor = spyOn(aiLive, "cursor").mockResolvedValue("0");
    try {
      const app = new Hono<{
        Variables: { actor: RequestAuthority["actor"]; user: User; credentialKind: "session"; runtime: { apps: [] } };
      }>();
      app.get("/fixture", async (c) => {
        c.set("actor", { kind: "user", user: person });
        c.set("user", person);
        c.set("credentialKind", "session");
        c.set("runtime", { apps: [] });
        const data = await loadCodePage(c, { owner: { codeId: f.codeId }, href: "/fixture", canManageOwner: person.id === memberId });
        const html = renderToString(() =>
          createComponent(LocaleProvider, {
            locale: "de",
            get children() {
              return createComponent(CodePage, { data });
            },
          }),
        );
        return c.json({ data, html });
      });
      const response = await app.request("http://cloud.test/fixture");
      expect(response.status).toBe(200);
      expect(failures).toEqual([]);
      const { data, html } = z
        .object({
          data: z.object({ state: z.object({ kind: z.literal("ready"), pages: CodePageLinksSchema.nullable() }) }),
          html: z.string(),
        })
        .parse(await response.json());
      expect(data.state.kind).toBe("ready");
      expect(calls).toContain("code.version.read");
      return { pages: data.state.pages, html: String(html) };
    } finally {
      invoke.mockRestore();
      cursor.mockRestore();
    }
  }

  test("all page-producing read paths omit guest pages, including delegated reads and SSR", async () => {
    for (const grant of ["owner", "editor", "reader"] as const) {
      const f = await fixture(guest, grant);
      // Mandatory viewer in describeCodePages is the compile-time guard for every new projection caller.
      const reads = {
        version: async () => (await readCodeVersion(input(f), { authority: authority(guest) })).pages?.pages ?? [],
        capability: async () => {
          const result = await aiCapabilities.queries["code.version.read"].run(input(f), execution(guest, true));
          expect(result.ok).toBe(true);
          return result.ok ? (result.data.data.pages?.pages ?? []) : [];
        },
        ssr: async () => {
          const page = await ssr(f, guest);
          expect(page.html).not.toContain(`href="/code/${f.codeId}/`);
          return page.pages?.pages ?? [];
        },
        preview: async () => {
          if (grant !== "owner") {
            await expect(
              previewCodeActivation({ codeId: f.codeId, versionId: f.versionId }, { authority: authority(guest) }),
            ).rejects.toThrow();
            return [];
          }
          return (
            (await previewCodeActivation({ codeId: f.codeId, versionId: f.versionId }, { authority: authority(guest) })).pages?.pages ?? []
          );
        },
        turn: () => loadCodeChatPages({ conversationId: f.conversationId, userId: guest.id, signal: AbortSignal.timeout(10000) }),
        projection: async () =>
          projectCodeChatPages(
            [
              {
                code_id: f.codeId,
                version_id: f.versionId,
                user_id: guest.id,
                title: "Fixture",
                manifest: chatPageManifest,
                owner_kind: "person",
                owner_user_id: guest.id,
                owner_app_id: null,
                owner_type: null,
                owner_id: null,
              },
            ],
            new Map([[f.versionId, { codeId: f.codeId, person: guest, permission: "editor" }]]),
          ),
      };
      for (const [path, read] of Object.entries(reads)) expect({ path, pages: await read() }).toEqual({ path, pages: [] });
    }
  });
  test("the same full paths retain a member owner's pages", async () => {
    const f = await fixture(member, "owner");
    expect((await readCodeVersion(input(f), { authority: authority(member, true) })).pages?.pages).toHaveLength(2);
    const page = await ssr(f, member);
    expect(page.pages?.pages).toHaveLength(2);
    expect(page.html).toContain(`href="/code/${f.codeId}/`);
    expect(
      (await previewCodeActivation({ codeId: f.codeId, versionId: f.versionId }, { authority: authority(member) })).pages?.pages,
    ).toHaveLength(2);
    expect(
      await loadCodeChatPages({ conversationId: f.conversationId, userId: member.id, signal: AbortSignal.timeout(10000) }),
    ).toHaveLength(1);
  });
});
