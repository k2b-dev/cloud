import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, loadavg } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import { z } from "zod";
import {
  command,
  freeLoopbackPort,
  localTls,
  Runtime,
  repository,
  runtimeImage,
  worktreePath,
} from "../../../../scripts/perf-baseline/runtime";
import { Api, waitForRoutes } from "../../../../scripts/perf-baseline/seed";
import { anchor, digestPlan, fixtureShortIds, planLargeMailbox, seedLargeMailbox } from "../../test/fixtures/large-mailbox";
import { Arrival } from "./arrival";
import { measureBrowsers } from "./browser";
import {
  assertRunUrl,
  capturePlan,
  combineDatabase,
  emptySample,
  explain,
  finalizeSample,
  firstAtOrAfter,
  monotonicMs,
  postgresArgs,
  postgresLog,
  postgresProblems,
  readDatabase,
  request,
  requestStatements,
  reset,
  setExplainDuration,
} from "./measure";
import {
  type DatabaseMeasurement,
  type Options,
  parsePrevious,
  type Result,
  renderSummary,
  resultSchema,
  type Sample,
  sortedJson,
  summarizeSamples,
} from "./model";

import { draftSeedBodies, mailboxBody, searchBodies } from "./requests";
import { seedWithAbort } from "./seed";

const resourceSchema = z.object({ id: z.string().min(1) });
const workspaceSchema = z.object({
  nextListCursor: z.string().nullable(),
  listItems: z.array(resourceSchema),
  folders: z.array(z.object({ id: z.string(), total: z.number(), unread: z.number() })),
});
type Action = (sample: Sample) => Promise<void>;

async function liveArrival(
  api: Api,
  sample: Sample,
  runtime: Runtime,
  fixture: Awaited<ReturnType<typeof seedLargeMailbox>>,
  mailboxId: string,
  mailboxShortId: string,
  inboxShortId: string,
  uid: number,
) {
  const boundedApi = new Api(api.origin, AbortSignal.any([api.signal, AbortSignal.timeout(30_000)]));
  boundedApi.cookie = api.cookie;
  api = boundedApi;
  const url = `${api.origin.replace("https:", "wss:")}/api/mail/live`;
  // Bun's extended constructor supplies headers and narrowly scoped local TLS.
  const BunSocket = WebSocket as typeof WebSocket & { new (url: string, options: Bun.WebSocketOptions): WebSocket };
  const socket = new BunSocket(url, {
    headers: { Cookie: `session_token=${api.cookie}`, Origin: api.origin },
    ...localTls(api.origin, api.origin),
  });
  let ready = false,
    failure: string | null = null;
  const deliveryTimes: number[] = [];
  socket.onopen = () => socket.send(JSON.stringify({ t: "sub", id: "m", channel: "mailbox", scope: { mailbox: mailboxShortId } }));
  socket.onerror = () => {
    failure = "Mail live socket failed";
  };
  socket.onclose = (event) => {
    failure = `Mail live socket closed: ${event.code} ${event.reason}`;
  };
  socket.onmessage = (event) => {
    let value: unknown;
    try {
      value = JSON.parse(String(event.data));
    } catch {
      failure = "Malformed Mail live JSON";
      return;
    }
    const frame = z
      .object({ t: z.string(), data: z.object({ conversationId: z.string().nullable() }).optional(), code: z.string().optional() })
      .safeParse(value);
    if (!frame.success) {
      failure = "Malformed Mail live frame";
      return;
    }
    if (frame.data.t === "ready") ready = true;
    if (frame.data.t === "revoked" || frame.data.t === "error" || frame.data.t === "resync")
      failure = `Live subscription ${frame.data.t}: ${frame.data.code ?? ""}`;
    if (frame.data.t === "event" && frame.data.data?.conversationId === null) deliveryTimes.push(monotonicMs());
  };
  const wait = async (condition: () => boolean, label: string, timeout = 30_000) => {
    const deadline = performance.now() + timeout;
    while (!condition()) {
      api.signal.throwIfAborted();
      if (failure) throw new Error(failure);
      if (performance.now() > deadline) throw new Error(`${label} timed out after ${timeout} ms`);
      await Bun.sleep(20);
    }
  };
  let arrival: Arrival | undefined;
  try {
    await wait(() => ready, "Live subscribe");
    arrival = new Arrival({
      signal: api.signal,
      runtime,
      origin: api.origin,
      mailboxId,
      remoteResourceId: fixture.remoteResourceId,
      folderId: fixture.inboxId,
      uid,
    });
    const started = arrival;
    // Observe visibility concurrently with event delivery, not after the event arrives.
    await wait(() => started.committed !== undefined || started.failure !== null || started.exited, "Ingest commit");
    if (started.failure) throw new Error(started.failure);
    const commit = await started.requireCommit();
    let visibleAt: number | undefined;
    const visibility = async () => {
      const deadline = performance.now() + 30_000;
      while (performance.now() < deadline) {
        api.signal.throwIfAborted();
        const snapshot = workspaceSchema.parse(
          await request(
            api,
            sample,
            `/api/mail/mailboxes/${mailboxShortId}/workspace-route?href=${encodeURIComponent(`/app/mail/${mailboxShortId}?folder=${inboxShortId}`)}`,
          ),
        );
        if (snapshot.listItems.some((item) => item.id === commit.conversationId)) {
          visibleAt = monotonicMs();
          return;
        }
        await Bun.sleep(50);
      }
      throw new Error("Arrival not visible in workspace after 30000 ms");
    };
    const outcomes = await Promise.allSettled([
      visibility(),
      wait(() => firstAtOrAfter(deliveryTimes, commit.enqueuedAt) !== undefined, "Live event"),
    ]);
    for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
    // Events before the enqueue belong to earlier work. One between enqueue and the
    // commit acknowledgement was delivered for this commit before the ack; count it as 0.
    sample.liveMs = Math.max(0, firstAtOrAfter(deliveryTimes, commit.enqueuedAt)! - commit.committedAt);
    sample.visibleMs = Math.max(0, visibleAt! - commit.committedAt);
    await started.finish();
  } finally {
    try {
      socket.close();
    } finally {
      await arrival?.dispose();
    }
  }
}

export async function run(options: Options) {
  const timestamp = new Date().toISOString();
  const out = await worktreePath(options.out ?? `.local/mail-perf/${timestamp.replaceAll(":", "-")}`);
  const previous = options.compare ? parsePrevious(JSON.parse(await readFile(options.compare, "utf8"))) : undefined;
  const plan = planLargeMailbox({
    seed: options.seed,
    anchor,
    messages: options.messages,
    conversations: options.conversations,
    folders: options.folders,
  });
  const planB = planLargeMailbox({ ...plan.parameters, seed: (options.seed + 1) >>> 0 }, fixtureShortIds(plan));
  const result: Result = {
    schemaVersion: 1,
    kind: "mail",
    metadata: {
      commit: "unknown",
      dirty: false,
      timestamp,
      bunVersion: Bun.version,
      runtimeImage: "unknown",
      cpuCount: cpus().length,
      cpuModel: cpus()[0]?.model ?? "unknown",
      loadAverage: { start: loadavg(), end: [] },
      runs: options.runs,
      fixture: plan.parameters,
      fixtureDigest: digestPlan(plan),
      shape: plan.shape,
      seedDurationMs: null,
      mailboxB: { fixture: planB.parameters, fixtureDigest: digestPlan(planB), seedDurationMs: null },
      bm25: null,
      pgTextsearch: null,
      postgresVersion: null,
      origin: "not started",
    },
    idle: null,
    scenarios: [],
    browser: options.browsers.length
      ? {
          engines: options.browsers,
          versions: {},
          playwrightVersion: "unknown",
          runs: options.browserRuns,
          pages: [],
          interactions: [],
          errors: [],
        }
      : null,
    notes: [
      "No provider connection or credentials. example.test provider rows are seeded through persistence; selected_for_sync=false and mailbox sync_enabled=false. No connector endpoint policy change.",
      "Fixture .txt attachments have the current extractor's terminal unsupported state, preventing an extraction recovery backlog.",
      "Local server/API emulation only: no browser hydration, provider/network latency or production hardware prediction. Shared caches and run order affect the first (cold) request; no cache flush or scenario warm-up.",
      "Core/Mail background loops remain active. Idle attribution reports their statement rate; it is not subtracted from scenario totals.",
      "Attribution excludes the observer role (seeding, resets and statistics reads). Live ingest uses the application role and is included. Nested SQL calls and their inclusive execution times count too; DB ms can double-count nested work.",
      "auto_explain.log_min_duration is initialized with ALTER SYSTEM rather than a startup -c override, which would prevent reload-based toggling.",
      "auto_explain is disabled for timed requests; one extra instrumented pass follows each scenario and is excluded from timings and attribution. Live passes add disposable messages; compose returns fresh seed IDs.",
      "Brotli bytes are a local body recompression, not network bytes. TTFB ends at response headers; total ends at consumed body, excluding compression and HTML inspection.",
      ...(options.skipBuild ? ["--skip-build reused bundles; recorded commit does not prove their provenance."] : []),
      ...(options.browsers.length
        ? [
            "Browser part runs after the server scenarios on the same installation. Every load and interaction sample uses a fresh context, so start pages load cold (Chromium cache disabled); interactions then reuse what their start page cached. Local emulation in the run-owned Playwright container, not real phones.",
            "Interaction times are epoch milliseconds from the trusted input event (live: the ingest worker's commit acknowledgement on the host; the container shares the host clock) to the animation frame in which the end state first holds. A probe checks the end state once per frame.",
          ]
        : []),
    ],
    errors: [],
  };
  if (existsSync(join(out, "result.json")) || existsSync(join(out, "summary.md")))
    throw new Error("Output already contains result.json or summary.md; choose a fresh --out directory");
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "result.json"), sortedJson(result), { flag: "wx" });
  await writeFile(join(out, "summary.md"), renderSummary(result, previous), { flag: "wx" });
  const controller = new AbortController();
  const interrupted = () => controller.abort(new Error("Interrupted; cleaning up this run"));
  process.on("SIGINT", interrupted);
  process.on("SIGTERM", interrupted);
  let runtime: Runtime | undefined, db: SQL | undefined, explainControl: SQL | undefined;
  const definitions: Array<{ id: string; group: string; notes?: string[]; action: Action }> = [];
  try {
    const [commit, status, image] = await Promise.all([
      command(["git", "rev-parse", "HEAD"]),
      command(["git", "status", "--porcelain"]),
      readFile(join(repository, "Dockerfile"), "utf8"),
    ]);
    Object.assign(result.metadata, { commit, dirty: status.length > 0, runtimeImage: runtimeImage(image) });
    runtime = new Runtime(await freeLoopbackPort(), result.metadata.runtimeImage, controller.signal);
    result.metadata.origin = runtime.origin;
    await mkdir(join(runtime.directory, "tmp"), { recursive: true });
    const apps = ["core", "mail", "gateway"];
    await runtime.build(apps, options.skipBuild);
    await runtime.start(apps, { postgresArgs, publish: ["postgres", "valkey"] });
    const pgUrl = assertRunUrl(
      `postgresql://ipa:ipa@127.0.0.1:${runtime.published.postgres}/cloud_perf_test`,
      runtime.published.postgres,
      "postgresql:",
      "cloud_perf_test",
    );
    // This connection follows the global setting so reload checks can observe
    // it; the observer's role override intentionally always stays at -1.
    explainControl = new SQL(pgUrl);
    await explainControl`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`;
    await explainControl`CREATE ROLE mail_perf_observer LOGIN SUPERUSER PASSWORD 'run-owned-observer'`;
    await explainControl`ALTER ROLE mail_perf_observer SET auto_explain.log_min_duration = -1`;
    const observerUrl = new URL(pgUrl);
    observerUrl.username = "mail_perf_observer";
    observerUrl.password = "run-owned-observer";
    db = new SQL(observerUrl.href);
    await setExplainDuration(explainControl, -1);
    const api = new Api(runtime.origin, controller.signal);
    const userId = await api.login(runtime.adminToken);
    await waitForRoutes(api, apps, runtime);
    const mailbox = resourceSchema.parse(await api.request("/api/mail/mailboxes", "POST", mailboxBody()));
    const [mailboxRow] = await db<{ id: string }[]>`SELECT id FROM mail.mailboxes WHERE short_id = ${mailbox.id}`;
    if (!mailboxRow) throw new Error("Created mailbox not found by short_id");
    const start = performance.now();
    const seedDb = db;
    const fixture = await seedWithAbort(seedDb, controller.signal, () =>
      seedLargeMailbox(seedDb, plan, { mailboxId: mailboxRow.id, userIds: [userId] }),
    );
    result.metadata.seedDurationMs = performance.now() - start;
    const mailboxB = resourceSchema.parse(
      await api.request("/api/mail/mailboxes", "POST", { ...mailboxBody(), name: `${mailboxBody().name} B` }),
    );
    const [mailboxBRow] = await db<{ id: string }[]>`SELECT id FROM mail.mailboxes WHERE short_id = ${mailboxB.id}`;
    if (!mailboxBRow) throw new Error("Created mailbox B not found by short_id");
    const startB = performance.now();
    await seedWithAbort(seedDb, controller.signal, () => seedLargeMailbox(seedDb, planB, { mailboxId: mailboxBRow.id, userIds: [userId] }));
    result.metadata.mailboxB!.seedDurationMs = performance.now() - startB;
    const [pg] = await db<
      { version: string; bm25: boolean; pg_textsearch: boolean }[]
    >`SELECT version(), to_regclass('mail.message_contents_bm25_idx') IS NOT NULL AS bm25, EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_textsearch') AS pg_textsearch`;
    if (!pg) throw new Error("Missing Postgres metadata");
    Object.assign(result.metadata, { postgresVersion: pg.version, bm25: pg.bm25, pgTextsearch: pg.pg_textsearch });
    const base = `/api/mail/mailboxes/${mailbox.id}`,
      page = `/app/mail/${mailbox.id}`;
    const route = (query = "") => `${base}/workspace-route?href=${encodeURIComponent(page + query)}`;
    const add = (id: string, group: string, action: Action, notes?: string[]) => definitions.push({ id, group, action, notes });
    add("ssr-mailbox", "SSR", async (s) => {
      await request(api, s, page, undefined, true);
    });
    add("ssr-large-thread", "SSR", async (s) => {
      await request(api, s, `${page}?conversation=${plan.shape.largestThreadId}`, undefined, true);
    });
    for (const publicApi of [false, true])
      add(
        publicApi ? "list-paging-public" : "list-paging-route",
        "Lists",
        async (s) => {
          const first = await request(api, emptySample(), publicApi ? `${base}/conversations?limit=50` : route());
          let cursor = publicApi
            ? z.object({ nextCursor: z.string().nullable() }).parse(first).nextCursor
            : workspaceSchema.parse(first).nextListCursor;
          for (let p = 2; p <= 5; p++) {
            if (!cursor) throw new Error(`Fixture has no cursor for page ${p}; use more conversations`);
            const value = await request(
              api,
              s,
              publicApi
                ? `${base}/conversations?limit=50&cursor=${encodeURIComponent(cursor)}`
                : route(`?cursor=${encodeURIComponent(cursor)}`),
            );
            cursor = publicApi
              ? z.object({ nextCursor: z.string().nullable() }).parse(value).nextCursor
              : workspaceSchema.parse(value).nextListCursor;
          }
        },
        [
          "Each invocation obtains page 1 as an untimed cursor prerequisite. Timings/bytes cover pages 2–5; database attribution also includes page 1.",
        ],
      );
    add(
      "list-paging-workspace",
      "Lists",
      async (s) => {
        const first = await request(api, emptySample(), route());
        const listSchema = workspaceSchema.pick({ nextListCursor: true, listItems: true });
        let cursor = listSchema.parse(first).nextListCursor;
        for (let p = 2; p <= 5; p++) {
          if (!cursor) throw new Error(`Fixture has no cursor for page ${p}; use more conversations`);
          const href = `${page}?cursor=${encodeURIComponent(cursor)}`;
          const value = await request(api, s, `${base}/workspace-list?href=${encodeURIComponent(href)}`);
          cursor = listSchema.parse(value).nextListCursor;
        }
      },
      [
        "Each invocation obtains page 1 as an untimed cursor prerequisite. Timings/bytes cover pages 2–5; database attribution also includes page 1.",
      ],
    );
    for (const [id, thread] of [
      ["detail-small", plan.shape.smallThreadId],
      ["detail-large", plan.shape.largestThreadId],
      ["detail-html", plan.shape.htmlThreadId],
    ])
      add(id!, "Details", async (s) => {
        await request(api, s, `${base}/workspace-detail/${thread}`);
      });
    for (const { id, body } of searchBodies(plan.shape))
      add(id, "Search", async (s) => {
        await request(api, s, `${base}/search`, body);
      });
    for (const [id, folder] of [
      ["folder-large", plan.shape.largeFolderId],
      ["folder-medium", plan.shape.mediumFolderId],
      ["folder-sparse", plan.shape.sparseOldFolderId],
    ])
      add(id!, "Folders and counts", async (s) => {
        await request(api, s, route(`?folder=${folder}`));
      });
    add("folder-medium-list", "Folders and counts", async (s) => {
      const href = `${page}?folder=${plan.shape.mediumFolderId}`;
      await request(api, s, `${base}/workspace-list?href=${encodeURIComponent(href)}`);
    });
    add("counts", "Folders and counts", async (s) => {
      await request(api, s, `${base}/conversation-view-counts`);
      const data = workspaceSchema.parse(await request(api, s, route()));
      s.requests.at(-1)!.folderCountsBytes = Buffer.byteLength(
        JSON.stringify(data.folders.map(({ id, total, unread }) => ({ id, total, unread }))),
      );
    });
    let arrival = plan.messages.length + 1;
    const activeRuntime = runtime;
    add(
      "live-arrival",
      "Live and compose",
      (s) => liveArrival(api, s, activeRuntime, fixture, mailboxRow.id, mailbox.id, plan.shape.largeFolderId, arrival++),
      [
        "Live protocol: sub id=m channel=mailbox scope={mailbox:shortId}; wait for ready, then await the mailbox-wide event (conversationId=null) written by the sync batch boundary. The application dispatcher polls within one second; no host-side wake or NATS client is started. Poll Inbox every 50 ms, bounded at 30 s. Commit time is the worker's transaction commit acknowledgement on the shared host epoch-based performance clock. Visibility includes IPC handoff and polling. Worker startup excluded from commit-to-live/visibility metrics; request totals include only visibility polls.",
      ],
    );
    const replyMessage =
      plan.messages.find((m) => m.conversation === plan.shape.mediumThreadId && m.from !== "perf@example.test") ??
      plan.messages.find((m) => m.conversation === plan.shape.mediumThreadId)!;
    add(
      "compose-open",
      "Live and compose",
      async (s) => {
        for (const body of draftSeedBodies(fixture.senderIdentityId, replyMessage)) {
          const seed = resourceSchema.parse(await request(api, s, `${base}/draft-seeds`, body));
          await request(api, s, `${page}/compose/local/${seed.id}?return=${encodeURIComponent(page)}`, undefined, true);
        }
      },
      [
        "Two draft-seed POSTs (new and reply), each followed by its /compose/local/<seedId> SSR page. This measures the server shell, not client seed-store mounting.",
      ],
    );
    const pageB = `/app/mail/${mailboxB.id}`;
    add("mailbox-switch-route", "Mailbox switch", async (s) => {
      await request(api, s, `/api/mail/mailboxes/${mailboxB.id}/workspace-route?href=${encodeURIComponent(pageB)}`);
    });
    add("ssr-mailbox-b", "Mailbox switch", async (s) => {
      await request(api, s, pageB, undefined, true);
    });
    result.scenarios = definitions.map(({ id, group, notes }) => ({
      id,
      group,
      status: "failed",
      errors: ["Not measured"],
      notes: notes ?? [],
      samples: [],
      metrics: null,
      database: null,
      plan: null,
      planError: null,
      unparsedPlans: 0,
    }));
    console.log("Measuring 5-second idle background window…");
    await reset(db);
    const idleStart = performance.now();
    await Bun.sleep(5000);
    controller.signal.throwIfAborted();
    result.idle = await readDatabase(db, idleStart, 1);
    for (const [i, definition] of definitions.entries()) {
      controller.signal.throwIfAborted();
      const scenario = result.scenarios[i]!;
      console.log(`Measuring ${scenario.id}…`);
      scenario.errors = [];
      try {
        // If a previous explain pass could not disable instrumentation, do not
        // measure another request until the disabled setting is restored.
        await setExplainDuration(explainControl, -1);
        const windows: DatabaseMeasurement[] = [];
        try {
          for (let n = 0; n <= options.runs; n++) {
            await reset(db);
            const sample = emptySample();
            scenario.samples.push(sample);
            const started = performance.now();
            try {
              await definition.action(sample);
            } finally {
              try {
                windows.push(await readDatabase(db, started, 1));
              } finally {
                await finalizeSample(sample);
              }
            }
          }
        } finally {
          scenario.database = combineDatabase(windows, scenario.samples.length || 1);
        }
        scenario.status = "ok";
        scenario.metrics = summarizeSamples(scenario.samples);
        const control = explainControl,
          statements = requestStatements(scenario.database, result.idle, scenario.samples.length || 1);
        const explainSample = emptySample();
        await capturePlan(scenario, async () => {
          try {
            return await explain(control, activeRuntime, statements, () => definition.action(explainSample));
          } finally {
            await finalizeSample(explainSample);
          }
        });
        controller.signal.throwIfAborted();
      } catch (error) {
        scenario.errors.push(String(error));
        controller.signal.throwIfAborted();
      }
      await writeFile(join(out, "result.json"), sortedJson(result));
      await writeFile(join(out, "summary.md"), renderSummary(result, previous));
    }
    if (result.browser) {
      console.log("Measuring browsers…");
      // The last scenario's explain pass may have failed to disable instrumentation; browser
      // timings must not include SQL analysis, so a failed restore stops the browser part.
      await setExplainDuration(explainControl, -1).catch((error: unknown) => {
        throw new Error(`Browser part not measured: auto_explain could not be disabled: ${String(error)}`);
      });
      await measureBrowsers(
        {
          signal: controller.signal,
          runtime,
          api,
          plan,
          fixture,
          mailbox: { shortId: mailbox.id, uuid: mailboxRow.id },
          mailboxB: { shortId: mailboxB.id },
          interactions: options.interactions,
          loads: options.loads,
          nextUid: () => arrival++,
        },
        result.browser,
        async () => {
          await writeFile(join(out, "result.json"), sortedJson(result));
          await writeFile(join(out, "summary.md"), renderSummary(result, previous));
        },
      );
    }
  } catch (error) {
    result.errors.push(String(error));
    if (runtime?.containers.includes(runtime.name("postgres"))) {
      try {
        const log = await command(["docker", "exec", runtime.name("postgres"), "tail", "-c", "1000000", postgresLog]);
        const problems = postgresProblems(log);
        if (problems.length) console.error(`PostgreSQL log problems:\n${problems.join("\n")}`);
      } catch (logError) {
        result.errors.push(`Postgres log: ${String(logError)}`);
      }
    }
    try {
      await runtime?.logs();
    } catch (logError) {
      result.errors.push(`Logs: ${String(logError)}`);
    }
  } finally {
    try {
      await db?.close();
    } catch (error) {
      result.errors.push(`Database cleanup: ${String(error)}`);
    }
    try {
      await explainControl?.close();
    } catch (error) {
      result.errors.push(`Explain control cleanup: ${String(error)}`);
    }
    try {
      await runtime?.cleanup(options.keep);
    } catch (error) {
      result.errors.push(String(error));
    }
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", interrupted);
    result.metadata.loadAverage.end = loadavg();
    try {
      resultSchema.parse(result);
    } catch (error) {
      result.errors.push(`Result validation: ${String(error)}`);
    }
    await writeFile(join(out, "result.json"), sortedJson(result));
    await writeFile(join(out, "summary.md"), renderSummary(result, previous));
    console.log(`Result: ${join(out, "result.json")}\nSummary: ${join(out, "summary.md")}`);
  }
  const browserFailed =
    !!result.browser &&
    (result.browser.errors.length > 0 ||
      [...result.browser.pages, ...result.browser.interactions].some((entry) => entry.profiles.some((p) => p.status === "failed")) ||
      result.browser.pages.some((page) => page.errors.length > 0));
  if (controller.signal.aborted || result.errors.length || browserFailed || result.scenarios.some((s) => s.status === "failed"))
    process.exitCode = controller.signal.aborted ? 130 : 1;
}
