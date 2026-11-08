import { beforeAll, expect, test } from "bun:test";
import { lazySync, sql } from "@k2b/cloud";
import { accounts } from "@k2b/cloud/services";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import type { MailRequestContext } from "./auth";
import { mergeConversations } from "./conversations";
import { retireMailRuleBroker } from "./retired-rule-broker";
import { readRetiredRuleRuns } from "./retired-rule-runs";
import { retireMailRules } from "./rule-retirement-migrate";

const suite = suiteFor("database", "nats");
const restorePreCutAdmission = async (db: typeof sql) => {
  await db`DELETE FROM mail.schema_migrations WHERE version = 3 AND name = 'rules_retired'`;
  await db`DROP TRIGGER mail_rules_retired_event ON workflows.event`;
  await db`DROP TRIGGER mail_rules_retired_run ON workflows.run`;
  await db`DROP TRIGGER mail_rules_retired_replay ON workflows.run`;
  await db`DROP TRIGGER mail_rules_retired_command ON mail.commands`;
  await db`DROP TRIGGER mail_rules_retired_draft ON mail.drafts`;
  await db`DROP TRIGGER mail_rules_retired_outbox ON mail.outbox_submissions`;
};

suite("Mail rule retirement", () => {
  let mailboxId: string;
  const workflowId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const mandateId = crypto.randomUUID();
  let reader: MailRequestContext;

  beforeAll(async () => {
    await migrate();
    const [mailbox] = await sql<{ id: string }[]>`INSERT INTO mail.mailboxes(short_id,name)
      VALUES(${newShortId()},'Retirement boundary') RETURNING id`;
    if (!mailbox) throw new Error("Missing retirement mailbox");
    mailboxId = mailbox.id;
    const [person] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,admin)
      VALUES(${`retirement-${crypto.randomUUID()}`},'local','user',false) RETURNING id`;
    const user = person && (await accounts.users.get({ id: person.id }));
    if (!user) throw new Error("Missing retirement reader");
    const [grant] = await sql<{ id: string }[]>`INSERT INTO auth.access(user_id,permission)
      VALUES(${user.id}::uuid,'read') RETURNING id`;
    if (!grant) throw new Error("Missing retirement read grant");
    await sql`INSERT INTO mail.mailbox_access(mailbox_id,access_id) VALUES(${mailboxId}::uuid,${grant.id}::uuid)`;
    reader = { actor: { kind: "user", user }, accessSubject: { type: "user", userId: user.id } };
    // Reconstruct an old installation before the one-way cut. Only this isolated
    // test database is changed, and all DDL + fixture admission commits together.
    await sql.begin(async (db) => {
      await restorePreCutAdmission(db);
      await db`INSERT INTO auth.mandates(id,subject_kind,subject_user_id,owner_app_id,workload_type,workload_id,policy)
        VALUES(${mandateId}::uuid,'user',${user.id}::uuid,'mail','incoming.automation',${workflowId},
          '{"version":1,"apps":["spaces"],"operations":["capability.query:space.read"],"actions":"preapproved"}')`;
      await db`INSERT INTO workflows.workflow(id,app_id,scope_id,key,name,created_by_kind)
        VALUES(${workflowId}::uuid,'mail',${mailboxId},'retired','Frozen rule','system')`;
      await db`INSERT INTO workflows.version(id,workflow_id,revision,source,source_hash,plan,language_id,language_version,manifest_hash,created_by_kind)
        VALUES(${versionId}::uuid,${workflowId}::uuid,1,'retained YAML',${"a".repeat(64)},'{}','mail',1,${"b".repeat(64)},'system')`;
      await db`INSERT INTO mail.workflow_profile(id,mailbox_id,enabled) VALUES(${workflowId}::uuid,${mailboxId}::uuid,true)`;
      await db`INSERT INTO workflows.event(id,app_id,scope_id,type,data,context,dedupe_key,occurred_at)
        VALUES(${eventId}::uuid,'mail',${mailboxId},'mail.message.received','{"message":"historical"}','{}','old-receipt','2026-11-01T12:00:00Z')`;
      await db`INSERT INTO workflows.run(id,app_id,scope_id,workflow_id,workflow_version_id,event_id,mode,state,authorization_snapshot,idempotency_key,occurred_at)
        VALUES(${runId}::uuid,'mail',${mailboxId},${workflowId}::uuid,${versionId}::uuid,${eventId}::uuid,
          'execute','queued','{"private":"never exposed"}','old-run','2026-11-01T12:00:00Z')`;
    });
    await migrate();
  });

  test("never admits a Mail rule event or run after a full migration restart", async () => {
    for (let restart = 0; restart < 2; restart++) {
      await migrate();
      await expect(
        Promise.resolve(sql`INSERT INTO workflows.event(app_id,scope_id,type,data,context,dedupe_key,occurred_at)
        VALUES('mail',${mailboxId},'mail.message.received','{}','{}',${`restart-${restart}`},'2026-11-02T00:00:00Z')`),
      ).rejects.toThrow("Mail rules are retired");
      await expect(
        Promise.resolve(sql`INSERT INTO workflows.run(app_id,scope_id,workflow_id,workflow_version_id,mode,authorization_snapshot,idempotency_key,occurred_at)
        VALUES('mail',${mailboxId},${workflowId}::uuid,${versionId}::uuid,'execute','{}',${`restart-${restart}`},'2026-11-02T00:00:00Z')`),
      ).rejects.toThrow("Mail rules are retired");
      await expect(Promise.resolve(sql`UPDATE workflows.run SET state='queued' WHERE id=${runId}::uuid`)).rejects.toThrow(
        "Mail rules are retired",
      );
      const [state] = await sql`SELECT state FROM workflows.run WHERE id=${runId}::uuid`;
      expect(state).toEqual({ state: "canceled" });
    }
    const [mandate] = await sql`SELECT state,revision::int AS revision FROM auth.mandates WHERE id=${mandateId}::uuid`;
    expect(mandate).toEqual({ state: "revoked", revision: 2 });
    const [audit] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM audit.events
      WHERE action='mandate.revoke' AND target_id=${mandateId}`;
    expect(audit?.count).toBe(1);
    const [triggers] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM pg_trigger
      WHERE tgname IN ('mail_capture_workflow_source','mail_capture_workflow_version_source',
        'conversations_invalidate_automation_status','placements_invalidate_automation_state') AND NOT tgisinternal`;
    expect(triggers?.count).toBe(0);
    await sql`INSERT INTO workflows.event(app_id,scope_id,type,data,context,dedupe_key,occurred_at)
      VALUES('grids',${mailboxId},'test.retained','{}','{}','grids-still-supported','2026-11-02T00:00:00Z')`;
  });

  test("restart removes old timer registrations and cancels queued backfills without processing them", async () => {
    const schedules = lazySync((sync) =>
      sync.scheduler({ id: "mail:workflow-schedules", delivery: { maxAttempts: 5, backoffMs: [5_000, 20_000, 60_000, 120_000] } }),
    )();
    const pump = lazySync((sync) =>
      sync.pump<{ mailboxId: string }, never, { key: string }>({
        id: "mail:incoming-automation-backfill",
        retention: { terminalMs: 30 * 24 * 60 * 60 * 1_000 },
        batchSize: 100,
        retry: { maxAttempts: 3, backoffMs: [1_000, 2_000, 4_000] },
        pull: async () => {
          throw new Error("Retired pump must never pull");
        },
        dispatch: async () => {
          throw new Error("Retired pump must never dispatch");
        },
      }),
    )();
    const operationId = crypto.randomUUID();
    const automationId = crypto.randomUUID();
    const key = `${automationId}:${operationId}`;
    const id = `mail:workflow-schedule:${operationId}`;
    await schedules.create({
      id,
      cron: "0 0 1 1 *",
      process: async () => {
        throw new Error("Retired timer must never tick");
      },
    });
    await sql`INSERT INTO mail.activity_events(mailbox_id,actor_kind,action,outcome,target_type,target_id,metadata)
      VALUES(${mailboxId}::uuid,'system','incoming_automation.backfill.start','confirmed','incoming_automation',${automationId}::uuid,
        ${{ operationId }}::jsonb)`;
    await pump.start({ key, input: { mailboxId } });
    await retireMailRuleBroker();
    await retireMailRuleBroker();
    expect(await schedules.get({ id })).toBeNull();
    expect(await pump.get({ key })).toMatchObject({ status: "canceled", dispatched: 0 });
  });

  test("retained runs, YAML and receipt evidence follow existing payload retention", async () => {
    const result = await readRetiredRuleRuns(reader, mailboxId, { run: runId });
    expect(result).toMatchObject({
      ok: true,
      data: {
        items: [
          {
            id: runId,
            name: "Frozen rule",
            snapshot: {
              source: "retained YAML",
              run: { id: runId, state: "canceled" },
              event: { data: { message: "historical" } },
            },
          },
        ],
      },
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(JSON.stringify(result.data)).not.toContain("never exposed");
    expect(JSON.stringify(result.data)).not.toContain("authorization_snapshot");
    await sql`UPDATE workflows.event SET data='{}', context='{}', payload_expired_at=now() WHERE id=${eventId}::uuid`;
    const expired = await readRetiredRuleRuns(reader, mailboxId, { run: runId });
    expect(expired).toMatchObject({
      ok: true,
      data: {
        items: [
          {
            id: runId,
            snapshot: {
              source: "retained YAML",
              event: { data: {}, context: {} },
              run: { state: "canceled" },
            },
          },
        ],
      },
    });
    expect(JSON.stringify(expired)).not.toContain('"historical"');
    const [source] = await sql`SELECT name,active FROM mail.workflow_source_names WHERE version_id=${versionId}::uuid`;
    expect(source).toEqual({ name: "Frozen rule", active: false });
    const [other] = await sql<{ id: string }[]>`INSERT INTO mail.mailboxes(short_id,name) VALUES(${newShortId()},'Other') RETURNING id`;
    expect(await readRetiredRuleRuns(reader, other!.id, { run: runId })).toMatchObject({ ok: false, error: { status: 403 } });
  });

  test("an accepted legacy send refuses retirement and remains available only for reconciliation", async () => {
    await sql.begin(async (db) => {
      await restorePreCutAdmission(db);
      const [resource] = await db<
        { id: string }[]
      >`INSERT INTO mail.remote_resources(mailbox_id,remote_locator,server_identity,scope_fingerprint)
        VALUES(${mailboxId}::uuid,'{}','{}',${"c".repeat(64)}) RETURNING id`;
      const [connection] = await db<{ id: string }[]>`INSERT INTO mail.provider_connections(owner_mailbox_id,name,email,username,
        imap_host,imap_port,imap_tls_mode,smtp_host,smtp_port,smtp_tls_mode,secret_kind,encrypted_secret)
        VALUES(${mailboxId}::uuid,'Old send','sender@example.test','sender','imap.example.test',993,'implicit',
          'smtp.example.test',465,'implicit','password','test-only-placeholder') RETURNING id`;
      const [binding] = await db<{ id: string }[]>`INSERT INTO mail.provider_bindings(remote_resource_id,connection_id,remote_locator)
        VALUES(${resource!.id}::uuid,${connection!.id}::uuid,'{}') RETURNING id`;
      const [identity] = await db<{ id: string }[]>`INSERT INTO mail.sender_identities(short_id,mailbox_id,label,from_address)
        VALUES(${newShortId()},${mailboxId}::uuid,'Old sender','sender@example.test') RETURNING id`;
      const [draft] = await db<{ id: string }[]>`INSERT INTO mail.drafts(short_id,mailbox_id,sender_identity_id,author_kind,author_id,
        last_editor_kind,last_editor_id,origin,delivery_class,state)
        VALUES(${newShortId()},${mailboxId}::uuid,${identity!.id}::uuid,'workflow',${versionId}::uuid,
          'workflow',${versionId}::uuid,'workflow','automatic_reply','sending') RETURNING id`;
      const [command] = await db<{ id: string }[]>`INSERT INTO mail.commands(mailbox_id,kind,state,actor_kind,actor_id,
        access_subject_kind,idempotency_key,request_hash,target,payload)
        VALUES(${mailboxId}::uuid,'send','confirmed','workflow',${versionId}::uuid,'system','accepted-send',${"c".repeat(64)},'{}','{}') RETURNING id`;
      const [outbox] = await db<
        { id: string }[]
      >`INSERT INTO mail.outbox_submissions(short_id,mailbox_id,draft_id,command_id,sender_identity_id,
        selected_binding_id,stable_message_id,state,requested_at,mime_date)
        VALUES(${newShortId()},${mailboxId}::uuid,${draft!.id}::uuid,${command!.id}::uuid,${identity!.id}::uuid,
          ${binding!.id}::uuid,'<accepted-retired@example.test>','accepted','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z') RETURNING id`;
      await expect(retireMailRules(db)).rejects.toThrow("requires drained provider effects (0 commands, 1 sends)");
      const [unchanged] = await db`SELECT state FROM mail.outbox_submissions WHERE id=${outbox!.id}::uuid`;
      expect(unchanged).toEqual({ state: "accepted" });
      // Explicit provider reconciliation on the old release, never a send retry.
      await db`UPDATE mail.outbox_submissions SET state='reconciled_accepted' WHERE id=${outbox!.id}::uuid`;
      await db`UPDATE mail.drafts SET state='sent' WHERE id=${draft!.id}::uuid`;
      await retireMailRules(db);
    });
    await sql`UPDATE auth.access SET permission='write' WHERE user_id=${reader.accessSubject.type === "user" ? reader.accessSubject.userId : null}::uuid`;
    const [historicDraft] = await sql<{ id: string }[]>`SELECT draft_id AS id FROM mail.outbox_submissions
      WHERE stable_message_id='<accepted-retired@example.test>'`;
    const conversations = await sql<
      { id: string; revision: number }[]
    >`INSERT INTO mail.conversations(short_id,mailbox_id,subject,latest_message_at)
      VALUES(${newShortId()},${mailboxId}::uuid,'Historical sent reply','2026-11-01T00:00:00Z'),
            (${newShortId()},${mailboxId}::uuid,'Merged destination','2026-11-01T00:00:00Z') RETURNING id,revision::int`;
    const [message] = await sql<{ id: string }[]>`INSERT INTO mail.message_contents
      (short_id,mailbox_id,message_id,subject,internal_date,size_bytes,content_hash)
      VALUES(${newShortId()},${mailboxId}::uuid,'<merge-retired@example.test>','Reply','2026-11-01T00:00:00Z',1,${"d".repeat(64)}) RETURNING id`;
    await sql`INSERT INTO mail.conversation_messages(conversation_id,message_id,position)
      VALUES(${conversations[0]!.id}::uuid,${message!.id}::uuid,0)`;
    await sql`UPDATE mail.drafts SET intent='reply', source_message_id=${message!.id}::uuid, conversation_id=${conversations[0]!.id}::uuid WHERE id=${historicDraft!.id}::uuid`;
    const merged = await mergeConversations({
      context: reader,
      mailboxId,
      targetConversationId: conversations[1]!.id,
      input: {
        sourceConversationId: conversations[0]!.id,
        expectedSourceRevision: conversations[0]!.revision,
        expectedTargetRevision: conversations[1]!.revision,
        confirm: true,
      },
    });
    expect(merged).toMatchObject({ ok: true });
    const [mergedDraft] = await sql`SELECT conversation_id,state FROM mail.drafts WHERE id=${historicDraft!.id}::uuid`;
    expect(mergedDraft).toEqual({ conversation_id: conversations[1]!.id, state: "sent" });
    await expect(Promise.resolve(sql`UPDATE mail.drafts SET state='scheduled' WHERE id=${historicDraft!.id}::uuid`)).rejects.toThrow(
      "Automatic replies are retired",
    );
    await expect(
      Promise.resolve(
        sql`UPDATE mail.outbox_submissions SET state='scheduled' WHERE mailbox_id=${mailboxId}::uuid AND stable_message_id='<accepted-retired@example.test>'`,
      ),
    ).rejects.toThrow("historical sends cannot execute");
  });

  test("unsettled legacy commands refuse the cut, without weakening their fence", async () => {
    await sql.begin(async (db) => {
      await restorePreCutAdmission(db);
      const [command] = await db<{ id: string }[]>`INSERT INTO mail.commands(mailbox_id,kind,state,actor_kind,actor_id,
        access_subject_kind,idempotency_key,request_hash,target,payload)
        VALUES(${mailboxId}::uuid,'move','needs_attention','workflow',${versionId}::uuid,'system',
          'unresolved',${"c".repeat(64)},'{}','{}') RETURNING id`;
      await expect(retireMailRules(db)).rejects.toThrow("requires drained provider effects (1 commands, 0 sends)");
      const [stored] = await db`SELECT state FROM mail.commands WHERE id=${command!.id}::uuid`;
      expect(stored).toEqual({ state: "needs_attention" });
      await db`UPDATE mail.commands SET state='reconciled' WHERE id=${command!.id}::uuid`;
      await retireMailRules(db);
    });
    await expect(
      Promise.resolve(sql`UPDATE mail.commands SET state='queued' WHERE mailbox_id=${mailboxId}::uuid AND idempotency_key='unresolved'`),
    ).rejects.toThrow("historical commands cannot execute");
  });
});
