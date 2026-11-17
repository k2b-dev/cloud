import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "@k2b/cloud";
import type { User } from "@k2b/cloud/contracts";
import { codeVersionCardsContract } from "@k2b/cloud/contracts/code-version-cards";
import { migrateApprovals } from "@k2b/cloud/services/approvals";
import { ok } from "@k2b/stdlib";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { meterSql } from "../../../scripts/fixtures/sql-meter";
import { databaseSuite, useFreshDatabase } from "../../../scripts/fixtures/test-infra";
import { readCodeVersionCards } from "../../core/src/code/version-cards";
import { migrate as migrateAudit } from "../../core/src/migrate/core/audit";
import { migrate as migrateAuth } from "../../core/src/migrate/core/auth";
import { migrate as migrateCode } from "../../core/src/migrate/core/code";
import { migrate as migrateVersions } from "../../core/src/migrate/core/code-versions";
import { migrate as migrateEvents } from "../../core/src/migrate/core/events";
import { registerSsrTestPlugin } from "../../ui/test/ssr-test-plugin";
import type { CodeQueryInvoke } from "./code-summary";
import { loadCodeVersionCards } from "./code-version-cards";

registerSsrTestPlugin({ dev: true, rootDir: mkdtempSync(join(tmpdir(), "assistant-approval-sql-")) });
const fixed = new Date("2026-11-17T08:00:00.000Z");
const userId = "11111111-1111-4111-8111-111111111111",
  codeId = "c_info01";
const user: User = {
  id: userId,
  uid: "fixture",
  provider: "local",
  profile: "user",
  roles: ["user"],
  givenname: "Test",
  sn: "Person",
  displayName: "Test Person",
  mail: null,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
};
const authority = {
  actor: { kind: "user" as const, user },
  accessSubject: { type: "user" as const, userId },
  credentialKind: "session" as const,
  scopes: [],
};
// In-process public transport adapter: real owning service and SQL, with the same schema as HTTP/third-party consumers.
const invoke: CodeQueryInvoke = async (invocation, schema) => {
  expect(invocation.capabilityId).toBe("code.version.cards");
  return ok({
    data: schema.parse(await readCodeVersionCards(codeVersionCardsContract.input.parse(invocation.input), { authority, locale: "de" })),
  });
};

databaseSuite()("the real approval card's SSR and invalidation SQL budget", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  const refs: Array<{ codeId: string; versionId: string }> = [];
  beforeAll(async () => {
    setSystemTime(fixed);
    database = await useFreshDatabase("assistant_version_cards");
    await migrateAuth();
    await migrateEvents();
    await migrateAudit();
    await migrateCode();
    await migrateApprovals();
    await migrateVersions();
    await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${userId}::uuid,'fixture','local','user')`;
    await sql`INSERT INTO code.codes(id,owner_kind,owner_user_id,title,created_by) VALUES(${codeId},'person',${userId}::uuid,'Terminübersicht',${userId}::uuid)`;
    const manifest = {
      version: 1,
      entry: "code.ts",
      ai: false,
      policyRows: [],
      permissions: [],
      hashes: { source: "a".repeat(64), bundle: "b".repeat(64), sdk: "c".repeat(64) },
      entrypoints: [
        { kind: "route", entrypoint: "home", file: "code.ts", line: 1, route: { method: "GET", path: "/", public: false, page: true } },
      ],
    };
    for (let number = 1; number <= 6; number++) {
      const [row] = await sql<
        { id: string }[]
      >`INSERT INTO code.versions(code_id,number,source_files,bundle,source_hash,bundle_hash,manifest,source_bytes,bundle_bytes,created_by,created_at)
        VALUES(${codeId},${number},'{}','',${"a".repeat(64)},${"b".repeat(64)},${JSON.stringify(manifest)}::text::jsonb,0,0,${userId}::uuid,${fixed.toISOString()}::timestamptz) RETURNING id`;
      refs.push({ codeId, versionId: row!.id });
    }
    await sql`UPDATE code.codes SET active_version_id=${refs.at(-1)!.versionId}::uuid,state='active' WHERE id=${codeId}`;
  });
  afterAll(async () => {
    await database?.drop();
    setSystemTime();
  });
  test("N server-rendered cards cost two reads; a covering invalidation also costs two", async () => {
    const { ApprovalSnapshotView } = await import("./frontend/code-version-card-ssr.test-fixture");
    const meter = await meterSql();
    try {
      for (const versions of [refs.slice(-1), refs]) {
        const statements = await meter.during(async () => {
          const initial = await loadCodeVersionCards(invoke, versions);
          const html = renderToString(() => createComponent(ApprovalSnapshotView, { initial }));
          expect(html.match(/data-chat-anchor=/g)).toHaveLength(versions.length);
          expect(html).toContain("Öffnen");
          expect(html).not.toContain("Diese Version wird geladen");
        });
        expect(statements).toHaveLength(2);
      }
      const statements = await meter.during(async () => {
        const refreshed = await loadCodeVersionCards(
          invoke,
          refs,
          refs.map((ref) => ref.versionId),
        );
        expect(refreshed.every((entry) => entry.state === "available" && entry.snapshot.pages === undefined)).toBe(true);
      });
      expect(statements).toHaveLength(2);
      expect(statements.every((statement) => !/UPDATE|rsql/i.test(statement))).toBe(true);
    } finally {
      await meter.close();
    }
  });
});
