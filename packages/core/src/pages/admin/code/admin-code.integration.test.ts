import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import * as provider from "@k2b/cloud/capabilities/server";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import type { User } from "@k2b/cloud/contracts";
import { createAppEventTestHarness } from "@k2b/cloud/events/testing";
import { registerSettings, toLegacySettingDefs } from "@k2b/cloud/services/settings/defaults";
import { readCodeAdminCounts } from "@k2b/cloud/ssr/code-admin-counts";
import { z } from "zod";
import { meterSql } from "../../../../../../scripts/fixtures/sql-meter";
import { databaseSuite, useMigratedDatabase } from "../../../../../../scripts/fixtures/test-infra";
import { CORE_SETTINGS } from "../../../_settings";
import { aiCapabilities } from "../../../capabilities";
import type { CodeContext } from "../../../code/access";
import * as access from "../../../code/access";
import * as authoringChecks from "../../../code/authoring-check";
import type { CodeSourceFiles } from "../../../code/contracts";
import { databaseDeletionDate } from "../../../code/database-deadline";
import { readCodePolicySnapshot, updateCodePolicy } from "../../../code/policy";
import { CODE_SETTINGS, codeSettings } from "../../../code/settings";
import { codeBundleHash, codeSourceHash, insertCodeRun } from "../../../code/store";
import type { CodeCheckedVersionManifest } from "../../../code/version-contracts";
import { decideCodeVersion, startCodeVersionApprovals, submitCodeVersion } from "../../../code/versions";
import { type CodeAreaQuery, parseCodeAreaQuery } from "./area";
import { type CodeAreaData, ok } from "./data";
import { loadCodeArea } from "./load";

/**
 * Administration › Code reads each section's first view in one server load with a fixed number of statements, however
 * many rows the lists hold, and its list queries stand on indexes at installation scale.
 */

const catalog = compileCapabilityManifest("example", {
  protocolVersion: 2,
  types: { item: { title: "Item", description: "A fictional item." } },
  actions: {
    "item.change": {
      title: "Change item",
      description: "Fixture operation.",
      openWorld: false,
      input: z.object({}).strict(),
      data: z.object({}).strict(),
      run: () => ({ ok: true as const, data: { data: {} } }),
      destructive: false,
      idempotency: "none",
      policy: { silent: "shared" },
      review: () => ({
        ok: true as const,
        data: {
          locale: "en",
          slots: {},
          sentence: { action: "Change", running: "Changing", done: "Changed", confirm: "Confirm", decline: "Cancel" },
        },
      }),
    },
  },
});

const people = {
  ben: "a1000000-0000-4000-8000-000000000001",
  ada: "a1000000-0000-4000-8000-000000000002",
  lea: "a1000000-0000-4000-8000-000000000003",
  mia: "a1000000-0000-4000-8000-000000000004",
  tom: "a1000000-0000-4000-8000-000000000005",
  kai: "a1000000-0000-4000-8000-000000000006",
  eva: "a1000000-0000-4000-8000-000000000007",
} as const;
const names: Record<keyof typeof people, string> = {
  ben: "Ben Schulz",
  ada: "Ada Kraus",
  lea: "Lea Muster",
  mia: "Mia Wolf",
  tom: "Tom Beispiel",
  kai: "Kai Brandt",
  eva: "Eva Lindner",
};
const groups = {
  buchhaltung: "b2000000-0000-4000-8000-000000000001",
  einkauf: "b2000000-0000-4000-8000-000000000002",
  vertrieb: "b2000000-0000-4000-8000-000000000003",
} as const;

const person = (id: string, admin: boolean): User => ({
  id,
  uid: id,
  roles: admin ? ["admin"] : ["user"],
  provider: "local",
  profile: "user",
  givenname: "Code",
  sn: "Pin",
  displayName: "Code Pin",
  mail: null,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
});
const context = (id: string, admin = true): CodeContext => ({
  authority: {
    actor: { kind: "user", user: person(id, admin) },
    accessSubject: { type: "user", userId: id },
    credentialKind: "session",
    scopes: [],
  },
  locale: "de",
});
const reviewer = context(people.ben);
const submission = (codeId: string, source: string, baseVersionId: string | null) => {
  const sourceFiles: CodeSourceFiles = { "code.ts": source, "lib/format.ts": `export const format = (value: string) => value.trim();\n` };
  const bundle = `bundle:${source}`;
  const manifest: CodeCheckedVersionManifest = {
    version: 1,
    entry: "code.ts",
    hashes: { source: codeSourceHash(sourceFiles, "code.ts"), bundle: codeBundleHash(bundle), sdk: "a".repeat(64) },
    entrypoints: [{ kind: "schedule", entrypoint: "weekly", title: "Lieferungen eintragen", cron: "0 8 * * 1", file: "code.ts", line: 1 }],
    ai: false,
    policyRows: ["silent_shared"],
    permissions: [{ operation: "example.item.change", target: { type: "example.item", id: "item_1" }, file: "code.ts", line: 2 }],
  };
  return { codeId, sourceFiles, bundle, manifest, baseVersionId };
};
const source = (n: number) => `export const run${n} = ${n};\nexample.item.change();\n// ${"Lieferung ".repeat(n)}`;

/** A Code of a person with its first version submitted for review. */
const pendingCode = async (id: string, owner: keyof typeof people, title: string) => {
  await sql`INSERT INTO code.codes(id,owner_kind,owner_user_id,title,created_by) VALUES(${id},'person',${people[owner]}::uuid,${title},${people[owner]}::uuid)`;
  return submitCodeVersion(submission(id, source(id.length + title.length), null), context(people[owner], false));
};

/** The section's first view as the page loads it, with the admin counts the request read for the admin bar. */
const load = async (query: Record<string, string>) => {
  const counts = await readCodeAdminCounts({ approverUserId: people.ben, roleContext: { kind: "request", authority: reviewer.authority } });
  return (parsed: CodeAreaQuery = parseCodeAreaQuery(query)) => loadCodeArea({ query: parsed, context: reviewer, locale: "de", counts });
};

/** The statements of one load, by the start of their text; each part must have loaded. */
const measure = async (meter: Awaited<ReturnType<typeof meterSql>>, query: Record<string, string>) => {
  const run = await load(query);
  let data: CodeAreaData | undefined;
  const statements = await meter.during(async () => {
    data = await run();
  });
  for (const [part, value] of Object.entries(data ?? {}))
    expect({ part, value: value === "failed" || value === "missing" ? value : "ok" }).toEqual({ part, value: "ok" });
  return { statements, data: data! };
};

let database: Awaited<ReturnType<typeof useMigratedDatabase>>;
databaseSuite()("Administration › Code: statements per first view and the indexes of its lists (integration)", () => {
  const spies: { mockRestore(): void }[] = [];
  let dispose: (() => void) | undefined;
  const versions: Record<string, Awaited<ReturnType<typeof submitCodeVersion>>> = {};
  beforeAll(async () => {
    database = await useMigratedDatabase("core_admin_code_pins");
    await sql`CHECKPOINT`;
    // Core's settings as `defineApp({ settings })` registers them, so the limits and the database retention read them.
    registerSettings(toLegacySettingDefs(CORE_SETTINGS));
    for (const [key, id] of Object.entries(people))
      await sql`INSERT INTO auth.users(id,uid,provider,profile,admin,display_name)
        VALUES(${id}::uuid,${key},'local','user',${key === "ben" || key === "ada"},${names[key as keyof typeof people]})`;
    for (const [cn, id] of Object.entries(groups))
      await sql`INSERT INTO auth.groups(id,cn,name,provider) VALUES(${id}::uuid,${cn},${cn[0]!.toUpperCase() + cn.slice(1)},'local')`;
    await sql`INSERT INTO auth.group_groups_v2(child_group_id,parent_group_id) VALUES(${groups.einkauf}::uuid,${groups.buchhaltung}::uuid)`;
    for (const [user, group] of [
      [people.lea, groups.buchhaltung],
      [people.mia, groups.einkauf],
      [people.tom, groups.vertrieb],
      [people.kai, groups.vertrieb],
    ] as const)
      await sql`INSERT INTO auth.user_groups_v2(user_id,group_id) VALUES(${user}::uuid,${group}::uuid)`;
    spies.push(
      spyOn(codeSettings, "get").mockImplementation(async (key) => {
        const definition = Object.entries(CODE_SETTINGS).find(([name]) => name === key)?.[1];
        if (!definition) throw new Error(`Unexpected setting ${key}`);
        return definition.default;
      }),
      spyOn(authoringChecks, "verifyCodeSubmission").mockResolvedValue([]),
      spyOn(provider, "getCapabilityCatalogApp").mockResolvedValue({
        ok: true,
        data: { appId: "example", appName: "Example", appIcon: "ti ti-code", appDescription: "Fixture", manifest: catalog },
      }),
      // A place names itself through its app's reader; that is a call to the app, never a statement.
      spyOn(access, "readCodeOwner").mockResolvedValue({ title: "Lager Nord", admin: true }),
    );
    createAppEventTestHarness("core", aiCapabilities);
    dispose = startCodeVersionApprovals();

    // Three group rules by two admins: the policy, its groups and three history entries.
    for (const [admin, group] of [
      [people.ben, groups.buchhaltung],
      [people.ada, groups.einkauf],
      [people.ben, groups.vertrieb],
    ] as const) {
      const current = await readCodePolicySnapshot();
      await updateCodePolicy(
        {
          revision: current.revision,
          definition: { preset: "custom", rules: [...current.definition.rules, { groupId: group, row: "silent_shared", value: "admin" }] },
        },
        context(admin),
      );
    }
    // Seven Code of four people and a place: three decided, five waiting (one of them a second version).
    for (const [id, owner, title] of [
      ["c_pins01", "lea", "Wochenbericht"],
      ["c_pins02", "mia", "Rechnungen ablegen"],
      ["c_pins03", "tom", "Lieferscheine prüfen"],
      ["c_pins04", "lea", "Mahnungen"],
      ["c_pins05", "mia", "Inventur"],
      ["c_pins06", "tom", "Angebote nachfassen"],
    ] as const)
      versions[id] = await pendingCode(id, owner, title);
    const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts(name,kind,created_by)
      VALUES('code:example.item:lager-nord','code',${people.lea}::uuid) RETURNING id`;
    await sql`INSERT INTO code.codes(id,owner_kind,owner_type,owner_id,service_account_id,title,created_by)
      VALUES('c_place1','resource','example.item','lager-nord',${account!.id}::uuid,'Lager zählen',${people.lea}::uuid)`;
    versions.c_place1 = await submitCodeVersion(submission("c_place1", source(7), null), context(people.lea, false));
    await decideCodeVersion(versions.c_pins01!.binding, { outcome: "approved" }, reviewer);
    await decideCodeVersion(versions.c_pins02!.binding, { outcome: "approved" }, context(people.ada));
    await decideCodeVersion(versions.c_pins03!.binding, { outcome: "rejected", comment: "Bitte ohne Löschen." }, reviewer);
    versions.c_pins01v2 = await submitCodeVersion(
      submission("c_pins01", `${source(1)}\nexample.item.change();`, versions.c_pins01!.version.id),
      context(people.lea, false),
    );
    for (const [code, state] of [
      ["c_pins01", "succeeded"],
      ["c_pins01", "failed"],
      ["c_pins02", "succeeded"],
    ] as const) {
      const runId = await insertCodeRun({
        codeId: code,
        versionId: versions[code]!.version.id,
        trigger: "schedule",
        entrypoint: "weekly",
        input: null,
      });
      await sql`UPDATE code.runs SET state=${state},started_at=created_at,ended_at=created_at WHERE id=${runId}::uuid`;
    }
    // Waiting cleanup, unused databases and three runner instances.
    await sql`INSERT INTO code.cleanup_jobs(code_id,kind,attempts,last_error) VALUES('c_pins03','code.delete',2,'busy'),('c_pins06','code.delete',0,NULL)`;
    await sql`INSERT INTO code.database_deletions(code_id,namespace,server_url) VALUES('c_gone01','code_c_gone01','http://rsql.test')`;
    for (const id of ["c_pins02", "c_pins03", "c_pins06"]) {
      await sql`INSERT INTO code.databases(code_id,namespace,server_url,reserved_bytes,connected,last_size_bytes)
        VALUES(${id},${`code_${id}`},'http://rsql.test',104857600,TRUE,4096)`;
      await sql`UPDATE code.databases SET unused_since=now()-interval '40 days' WHERE code_id=${id}`;
    }
    await sql`INSERT INTO code.runner_instances(instance_id,free_slots)
      SELECT gen_random_uuid(),4 FROM generate_series(1,3)`;
  }, 180_000);
  afterAll(async () => {
    dispose?.();
    for (const spy of spies.splice(0).reverse()) spy.mockRestore();
  });

  test("each section's first view costs a fixed number of statements", async () => {
    const meter = await meterSql();
    const report: Record<string, string[]> = {};
    try {
      const sections: [string, Record<string, string>][] = [
        ["approvals", {}],
        ["approval open", { sec: "approvals", id: versions.c_pins01v2!.version.id }],
        ["decided", { sec: "approvals", tab: "decided" }],
        ["decided open", { sec: "approvals", id: versions.c_pins03!.version.id }],
        ["automations", { sec: "code" }],
        ["automation open", { sec: "code", id: "c_pins01" }],
        ["policy", { sec: "policy" }],
        ["groups", { sec: "groups", id: groups.einkauf }],
        ["effective", { sec: "effective", id: people.mia }],
        ["history", { sec: "history" }],
        ["cleanup", { sec: "cleanup" }],
        ["databases", { sec: "databases" }],
        ["limits", { sec: "limits" }],
        ["runners", { sec: "runners" }],
      ];
      // Warm the caches a running server holds (settings, catalog), as every request after the first finds them.
      for (const [, query] of sections) await (await load(query))();
      for (const [name, query] of sections) report[name] = (await measure(meter, query)).statements;
    } finally {
      await meter.close();
    }
    const counts = Object.fromEntries(Object.entries(report).map(([name, list]) => [name, list.length]));
    console.log(JSON.stringify({ statements: counts }));
    // Every first view: the area's counts (one statement) and the section's own reads. An open approval adds the
    // review (its approval eligibility is the approvals service's own transaction) beside its list.
    expect(counts).toEqual({
      approvals: 4,
      "approval open": 30,
      decided: 2,
      "decided open": 13,
      automations: 3,
      "automation open": 18,
      policy: 8,
      groups: 8,
      effective: 5,
      history: 5,
      cleanup: 2,
      databases: 10,
      limits: 3,
      runners: 5,
    });
    const starts = (name: string) => report[name]!.map((statement) => statement.slice(0, 48));
    const area = "SELECT (SELECT count(*)::int FROM code.codes) AS";
    // A list reads its page, then one statement per kind of name, never one per row.
    expect(starts("approvals")).toEqual([
      area,
      "SELECT to_char(r.created_at AT TIME ZONE 'UTC','",
      "SELECT p.*, COALESCE((SELECT jsonb_agg(jsonb_bui",
      "WITH RECURSIVE members(user_id,id) AS ( SELECT u",
    ]);
    expect(starts("decided")).toEqual([area, "SELECT v.code_id,d.version_id,v.number,c.title,d"]);
    expect(starts("automations")).toEqual([
      area,
      "SELECT * FROM (SELECT b.*,CASE WHEN b.state='del",
      "SELECT count(*)::int AS total, count(DISTINCT CO",
    ]);
    expect(starts("history")).toEqual([
      area,
      "SELECT COUNT(*)::int AS count, 0::int AS automat",
      "SELECT * FROM audit.events WHERE TRUE AND action",
      "SELECT id,name FROM auth.groups WHERE id=ANY($1:",
      "SELECT id,COALESCE(NULLIF(display_name,''),uid) ",
    ]);
    expect(starts("cleanup")).toEqual([area, "SELECT j.*,COALESCE(c.title,j.code_id) AS title,"]);
    expect(starts("databases")).toEqual([
      area,
      "BEGIN",
      "SET LOCAL lock_timeout='100ms'",
      "SET LOCAL statement_timeout='2s'",
      "SELECT revision::text FROM code.database_retenti",
      "SELECT key, value FROM settings.entries WHERE ke",
      "SELECT code_id FROM code.databases WHERE unused_",
      "UPDATE code.databases d SET unused_policy_revisi",
      "SELECT d.code_id,c.title,COALESCE(NULLIF(u.displ",
      "COMMIT",
    ]);
  }, 120_000);

  test("the lists cost the same statements with more rows and more people", async () => {
    const meter = await meterSql();
    try {
      const before = {
        approvals: (await measure(meter, {})).statements,
        decided: (await measure(meter, { sec: "approvals", tab: "decided" })).statements,
        history: (await measure(meter, { sec: "history" })).statements,
        databases: (await measure(meter, { sec: "databases" })).statements,
      };
      // Two more people's Code, one decided by the second admin, another policy change and another unused database.
      versions.c_pins07 = await pendingCode("c_pins07", "kai", "Urlaubsplan");
      versions.c_pins08 = await pendingCode("c_pins08", "eva", "Bestellungen");
      await decideCodeVersion(versions.c_pins08!.binding, { outcome: "approved" }, context(people.ada));
      const current = await readCodePolicySnapshot();
      await updateCodePolicy(
        {
          revision: current.revision,
          definition: {
            preset: "custom",
            rules: current.definition.rules.map((rule) =>
              rule.groupId === groups.vertrieb ? { ...rule, value: "automatic" as const } : rule,
            ),
          },
        },
        context(people.ada),
      );
      await sql`INSERT INTO code.databases(code_id,namespace,server_url,reserved_bytes,connected,last_size_bytes)
        VALUES('c_pins07','code_c_pins07','http://rsql.test',104857600,TRUE,1024)`;
      await sql`UPDATE code.databases SET unused_since=now()-interval '3 days' WHERE code_id='c_pins07'`;
      const after = {
        approvals: await measure(meter, {}),
        decided: await measure(meter, { sec: "approvals", tab: "decided" }),
        history: await measure(meter, { sec: "history" }),
        databases: await measure(meter, { sec: "databases" }),
      };
      const listed = after.approvals.data.approvals;
      expect(ok(listed) ? listed.items.map((item) => item.codeId).sort() : listed).toEqual([
        "c_pins01",
        "c_pins04",
        "c_pins05",
        "c_pins06",
        "c_pins07",
        "c_place1",
      ]);
      console.log(
        JSON.stringify({
          before: Object.fromEntries(Object.entries(before).map(([name, list]) => [name, list.length])),
          after: Object.fromEntries(Object.entries(after).map(([name, read]) => [name, read.statements.length])),
        }),
      );
      for (const name of ["approvals", "decided", "history", "databases"] as const)
        expect({ name, statements: after[name].statements.length }).toEqual({ name, statements: before[name].length });
      // The page's one deadline statement gives each database the deadline the single-row refresh gives: 40 days unused
      // under a 30-day retention gets the seven days' advance notice, 3 days unused the end of its retention.
      const deadlines = await sql<{ code_id: string; since: Date; shown: Date; days: number; deadline: Date }[]>`
        SELECT code_id,unused_since AS since,unused_shown_at AS shown,unused_days AS days,unused_delete_at AS deadline
        FROM code.databases WHERE unused_since IS NOT NULL ORDER BY code_id`;
      expect(deadlines.map((row) => row.code_id)).toEqual(["c_pins02", "c_pins03", "c_pins06", "c_pins07"]);
      for (const row of deadlines)
        expect({
          id: row.code_id,
          off: Math.abs(row.deadline.getTime() - databaseDeletionDate(row.since, row.days, row.shown)!.getTime()) <= 1,
        }).toEqual({
          id: row.code_id,
          off: true,
        });
      expect(deadlines.map((row) => row.deadline.getTime() > row.since.getTime() + row.days * 86_400_000)).toEqual([
        true,
        true,
        true,
        false,
      ]);
    } finally {
      await meter.close();
    }
  }, 120_000);

  test("the main list queries use indexes at installation scale", async () => {
    // 5,000 automations of seven people, 15,000 versions, 10,000 decisions, 20,000 runs, 30,000 audit entries.
    const owners = sql.array(Object.values(people), "uuid");
    await sql`INSERT INTO code.codes(id,owner_kind,owner_user_id,title,state,created_by)
      SELECT 'c_bulk' || lpad(i::text,5,'0'),'person',(${owners}::uuid[])[1+i%7],'Automation ' || i,
        (ARRAY['draft','active','paused'])[1+i%3],(${owners}::uuid[])[1+i%7] FROM generate_series(1,5000) i`;
    await sql`INSERT INTO code.versions(code_id,number,source_files,bundle,source_hash,bundle_hash,manifest,source_bytes,bundle_bytes,created_by,created_at)
      SELECT c.id,n,jsonb_build_object('code.ts','export const n = ' || n || ';'),'bundle',md5(c.id || n) || md5(n || c.id),
        md5(c.id || n) || md5(n || c.id),'{"version":1,"policyRows":["silent_shared"]}'::jsonb,20,6,c.owner_user_id,now()-n*interval '1 day'
      FROM code.codes c CROSS JOIN generate_series(1,3) n WHERE c.id LIKE 'c_bulk%'`;
    await sql`INSERT INTO code.version_submissions(version_id,code_id,binding,approval_id)
      SELECT id,code_id,'{}'::jsonb,gen_random_uuid() FROM code.versions WHERE code_id LIKE 'c_bulk%'`;
    await sql`INSERT INTO approvals.requests(id,app_id,action,requester_kind,requester_ref,requester_app_id,assurance,sentence,
        args_digest,review_digest,status,created_at,expires_at,kind,approver_role)
      SELECT s.approval_id,'core','code.version','code_version','bulk:' || s.version_id,'core','confirm','Review','d','d',
        CASE WHEN v.number=3 AND right(s.code_id,2)='00' THEN 'pending' ELSE 'approved' END,v.created_at,now()+interval '7 days','code_version','admin'
      FROM code.version_submissions s JOIN code.versions v ON v.id=s.version_id WHERE s.code_id LIKE 'c_bulk%'`;
    await sql`INSERT INTO code.version_decisions(version_id,binding,approved,outcome,sole_admin,decided_by,decided_at,decided_via,auth_epoch)
      SELECT id,'{}'::jsonb,true,'approved',false,${people.ben}::uuid,created_at+interval '1 hour','session',0
      FROM code.versions WHERE code_id LIKE 'c_bulk%' AND number<=2`;
    await sql`INSERT INTO code.runs(code_id,version_id,trigger,entrypoint,state,payload_bytes,calls_limit,created_at,started_at,ended_at)
      SELECT v.code_id,v.id,'schedule','weekly','succeeded',4,10,now()-k*interval '1 hour',now()-k*interval '1 hour',now()-k*interval '1 hour'
      FROM code.versions v CROSS JOIN generate_series(1,4) k WHERE v.code_id LIKE 'c_bulk%' AND v.number=1`;
    await sql`INSERT INTO code.databases(code_id,namespace,server_url,reserved_bytes,connected)
      SELECT id,'code_' || id,'http://rsql.test',104857600,TRUE FROM code.codes WHERE id LIKE 'c_bulk%' AND right(id,1)<'6'`;
    await sql`UPDATE code.databases SET unused_since=now()-interval '5 days' WHERE code_id LIKE 'c_bulk%' AND right(code_id,2)='01'`;
    await sql`INSERT INTO code.cleanup_jobs(code_id,kind) SELECT id,'code.delete' FROM code.codes WHERE id LIKE 'c_bulk%' AND right(id,1)='9'`;
    await sql`INSERT INTO code.database_deletions(code_id,namespace,server_url)
      SELECT 'c_del' || i,'code_c_del' || i,'http://rsql.test' FROM generate_series(1000,1499) i`;
    await sql`INSERT INTO audit.events(action,outcome,created_at)
      SELECT (ARRAY['auth.login','core.code.run.started','core.settings.updated'])[1+i%3],'allowed',now()-i*interval '1 minute'
      FROM generate_series(1,30000) i`;
    for (const table of [
      "code.codes",
      "code.versions",
      "code.version_submissions",
      "code.version_decisions",
      "code.runs",
      "code.databases",
    ])
      await sql.unsafe(`ANALYZE ${table}`);
    for (const table of ["code.cleanup_jobs", "code.database_deletions", "approvals.requests", "audit.events", "auth.users"])
      await sql.unsafe(`ANALYZE ${table}`);

    // Keep these statements aligned with the first views' queries in code/admin.ts, code/lifecycle.ts,
    // code/database-retention.ts and the audit list; parameters stand as the values a first view binds.
    const plans = {
      approvals: explain(sql`EXPLAIN (ANALYZE, FORMAT JSON) SELECT s.approval_id,v.number,c.title,u.display_name,o.display_name,cmp.number
        FROM code.version_submissions s JOIN approvals.requests r ON r.id=s.approval_id
          JOIN code.versions v ON v.id=s.version_id JOIN code.codes c ON c.id=s.code_id
          LEFT JOIN auth.users u ON u.id=v.created_by LEFT JOIN auth.users o ON o.id=c.owner_user_id
          LEFT JOIN code.versions cmp ON cmp.id=(s.binding->>'comparisonVersionId')::uuid
        WHERE r.status='pending' AND r.expires_at>now() ORDER BY r.created_at DESC,r.id DESC LIMIT 21`),
      decided: explain(sql`EXPLAIN (ANALYZE, FORMAT JSON) SELECT v.code_id,d.version_id,c.title,u.display_name,o.display_name,a.display_name
        FROM code.version_decisions d JOIN code.versions v ON v.id=d.version_id JOIN code.codes c ON c.id=v.code_id
          LEFT JOIN auth.users u ON u.id=d.decided_by LEFT JOIN auth.users a ON a.id=v.created_by
          LEFT JOIN auth.users o ON o.id=c.owner_user_id
        ORDER BY d.decided_at DESC,d.version_id DESC LIMIT 20`),
      automations:
        explain(sql`EXPLAIN (ANALYZE, FORMAT JSON) SELECT * FROM (SELECT b.*,CASE WHEN b.state='deleting' THEN 'deleting' WHEN b.waiting THEN 'waiting' ELSE b.state END AS status
        FROM (SELECT c.id,c.title,c.state,c.owner_kind,c.owner_user_id,c.owner_type,c.owner_id,c.owner_app_id,
          COALESCE(NULLIF(u.display_name,''),u.uid) AS owner_name,
          EXISTS(SELECT 1 FROM code.version_submissions s JOIN approvals.requests r ON r.id=s.approval_id
            WHERE s.code_id=c.id AND r.status='pending' AND r.expires_at>now()) AS waiting,
          last.created_at AS last_run_at,last.state AS last_run_state,active.number AS active_number
        FROM code.codes c LEFT JOIN auth.users u ON u.id=c.owner_user_id
          LEFT JOIN LATERAL (SELECT created_at,state FROM code.runs r WHERE r.code_id=c.id ORDER BY created_at DESC,id DESC LIMIT 1) last ON true
          LEFT JOIN code.versions active ON active.id=c.active_version_id) b) x
        ORDER BY lower(x.title),x.id LIMIT 21`),
      "automation runs": explain(sql`EXPLAIN (ANALYZE, FORMAT JSON) SELECT id,state FROM code.runs WHERE code_id='c_bulk00007'
        ORDER BY created_at DESC,id DESC LIMIT 11`),
      history: explain(sql`EXPLAIN (ANALYZE, FORMAT JSON) SELECT * FROM audit.events WHERE TRUE AND action='core.code.policy.updated'
        ORDER BY created_at DESC,id DESC LIMIT 10 OFFSET 0`),
      cleanup: explain(sql`EXPLAIN (ANALYZE, FORMAT JSON) SELECT j.*,COALESCE(c.title,j.code_id) AS title
        FROM (SELECT id,code_id,kind,attempts,next_attempt_at,claimed_until,last_error,created_at FROM code.cleanup_jobs
          UNION ALL SELECT id,code_id,'database.delete' AS kind,attempts,next_attempt_at,claimed_until,last_error,created_at FROM code.database_deletions) j
        LEFT JOIN code.codes c ON c.id=j.code_id ORDER BY j.id LIMIT 51`),
      databases: explain(sql`EXPLAIN (ANALYZE, FORMAT JSON) SELECT code_id FROM code.databases WHERE unused_since IS NOT NULL
        ORDER BY code_id LIMIT 21`),
    };
    const read: Record<string, Awaited<ReturnType<typeof explain>>> = {};
    for (const [name, plan] of Object.entries(plans)) read[name] = await plan;
    console.log(JSON.stringify(read, null, 1));
    const large = [
      "codes",
      "versions",
      "version_submissions",
      "version_decisions",
      "runs",
      "databases",
      "cleanup_jobs",
      "database_deletions",
      "events",
      "requests",
    ];
    for (const [name, plan] of Object.entries(read))
      expect({ name, seqScans: plan.seqScans.filter((relation) => large.includes(relation)) }).toEqual({ name, seqScans: [] });
    // The index each list's WHERE and ORDER BY walks.
    for (const [name, index] of [
      ["approvals", "approvals_requests_role_pending"],
      ["decided", "version_decisions_recent"],
      ["automations", "codes_title_order"],
      ["automation runs", "runs_code_history"],
      ["history", "idx_audit_events_action"],
      ["cleanup", "cleanup_jobs_pkey"],
      ["databases", "databases_unused_code"],
    ] as const)
      expect({ name, index: read[name]?.indexes.includes(index) }).toEqual({ name, index: true });
  }, 180_000);
});

type PlanNode = { "Node Type": string; "Relation Name"?: string; "Index Name"?: string; "Actual Rows"?: number; Plans?: PlanNode[] };
const planNodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(planNodes)];
/** The relations a plan reads by sequential scan, the indexes it uses, and its execution time. */
const explain = async (query: Promise<{ "QUERY PLAN": [{ Plan: PlanNode; "Execution Time": number }] }[]>) => {
  const [row] = await query;
  const result = row?.["QUERY PLAN"][0];
  if (!result) throw new Error("EXPLAIN returned no plan");
  const nodes = planNodes(result.Plan);
  return {
    seqScans: nodes.flatMap((node) => (node["Node Type"] === "Seq Scan" && node["Relation Name"] ? [node["Relation Name"]] : [])),
    indexes: [...new Set(nodes.flatMap((node) => (node["Index Name"] ? [node["Index Name"]] : [])))],
    executionMs: result["Execution Time"],
  };
};

// Imported session-fixture cleanup runs at file scope; keep its database until it has finished.
afterAll(async () => {
  await database?.drop();
});
