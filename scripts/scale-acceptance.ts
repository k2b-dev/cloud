#!/usr/bin/env bun
/** Cross-replica acceptance against an isolated, disposable production Compose stack. */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { SQL } from "bun";
// Reuse Notebooks' installed Yjs dependency; this harness adds no package dependency.
import * as Y from "../packages/notebooks/node_modules/yjs";
import type { SmtpSinkMessage } from "./fixtures/smtp-sink";
import { dotenvLeak } from "./fixtures/test-infra-env";
import { runUnderHeavyLock } from "./heavy-lock";
import { appIds, devServiceName, imageName, workspaceRoot } from "./workspace";

export const SCALED_APPS = ["core", "mail", "chat", "notebooks"] as const;
type App = (typeof SCALED_APPS)[number];
const APPS = ["gateway", ...SCALED_APPS];
const HOST = "cloud.scale-acceptance.test";
const ORIGIN = `https://${HOST}`;
export const HELP = `Usage: bun --no-env-file scripts/scale-acceptance.ts [options]

Boot a disposable Compose project with two Core, Mail, Chat and Notebooks replicas.
Requires Docker and installed workspace dependencies. Build @k2b/ui first:
  bun run --cwd packages/ui build

  --image-tag <tag>  Use existing ghcr.io/k2b-dev images (pull if missing), instead of building.
  --replicas <n>     1 or 2 (default 2). With 1, the final cross-replica guard MUST fail.
  --help            Show this help without taking a heavy slot or contacting Docker.

The script takes a machine heavy slot itself. CLOUD_HEAVY_SLOTS controls available slots.
SIGKILL recovery can take eight minutes. Containers, volumes and built tags are always removed.
`;
export const parseOptions = (args: string[]) => {
  const { values } = parseArgs({
    args,
    options: { help: { type: "boolean" }, "image-tag": { type: "string" }, replicas: { type: "string", default: "2" } },
    strict: true,
    allowPositionals: false,
  });
  check(values.replicas === "1" || values.replicas === "2", "--replicas must be 1 or 2");
  const imageTag = values["image-tag"];
  check(imageTag === undefined || /^[\w][\w.-]{0,127}$/.test(imageTag), "--image-tag must be a Docker image tag");
  return { help: values.help ?? false, imageTag, replicas: Number(values.replicas) };
};

/** Only Docker's client configuration crosses the child boundary, never Compose interpolation. */
export const dockerEnvironment = (inherited: Record<string, string | undefined>): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT"]) {
    const value = inherited[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
};

/** Complete, fresh interpolation input. No values are read from the caller's environment. */
export const composeEnvironment = (imageTag: string, run: string): Record<string, string> => ({
  CLOUD_IMAGE_TAG: imageTag,
  CLOUD_HOST: HOST,
  POSTGRES_USER: "scale",
  POSTGRES_PASSWORD: randomBytes(24).toString("hex"),
  POSTGRES_DB: `scale_${run}_test`,
  APP_SECRET: randomBytes(32).toString("hex"),
  CLOUD_OAUTH_BROKER_SECRET: randomBytes(32).toString("hex"),
  CLOUD_IDENTITY_KEY_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  ADMIN_LOGIN_TOKEN: randomBytes(32).toString("hex"),
  SYNC_NAMESPACE: `scale-${run}`,
  OUTGOING_MAIL_ALLOWED_TARGETS: "sinks",
  NATS_CREDS_FILE: "",
  NATS_TLS_CA_FILE: "",
  GATEWAY_TRUSTED_PROXIES: "",
  GATEWAY_OPS_WEBHOOK_ALLOWED_TARGETS: "",
  NATS_ADMIN_SERVERS: "",
  NATS_ADMIN_CREDS_FILE: "",
  NATS_ADMIN_NKEY_SEED_FILE: "",
  NATS_ADMIN_TLS_CA_FILE: "",
  CLOUD_IDENTITY_NEXT_KEY: "",
  CLOUD_IDENTITY_PREVIOUS_KEY: "",
  CLOUD_MAIL_APP_CREDENTIAL: "",
  ASSISTANT_RSQL_ALLOWED_TARGETS: "",
  NOTEBOOKS_SNAPSHOT_ALLOWED_TARGETS: "",
  PULSE_SCRAPE_ALLOWED_TARGETS: "",
  GEO_ALLOWED_TARGETS: "",
});
export const envFileContents = (env: Record<string, string>): string =>
  Object.entries(env)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");

export type Replica = { id: string; ip: string; url: string; number: number };
export type ReplicaEvidence = { a: Replica; b: Replica; served: Set<string> };
export const assertBothReplicasServed = (app: string, evidence: ReplicaEvidence, running: Set<string>, killed?: string) => {
  const { a, b, served } = evidence;
  check(a.id !== b.id, `${app}: replica B is the same container as replica A; the cross-replica run would be vacuous`);
  check(a.ip && b.ip && a.ip !== b.ip, `${app}: replica A and B must have different internal IPs`);
  for (const replica of [a, b]) {
    check(running.has(replica.id) || replica.id === killed, `${app}: replica ${replica.number} is no longer running`);
    check(served.has(replica.id), `${app}: replica ${replica.number} served no scenario step`);
  }
};
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const phase = (name: string, evidence: Record<string, unknown> = {}) => console.log(JSON.stringify({ phase: name, ...evidence }));
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Failed probes are retried only inside this bounded loop; assertions stay outside it. */
const poll = async <T>(label: string, probe: () => Promise<T | undefined | false>, timeoutMs = 60_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  let last = "condition not reached";
  do {
    try {
      const value = await probe();
      if (value !== undefined && value !== false) return value;
    } catch (error) {
      last = message(error);
    }
    await Bun.sleep(Math.min(250, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new Error(`${label} timed out after ${timeoutMs} ms: ${last}`);
};

type Inspect = {
  Id: string;
  State: { Running: boolean };
  Config: { Labels: Record<string, string> };
  NetworkSettings: {
    Ports: Record<string, { HostIp: string; HostPort: string }[] | null>;
    Networks: Record<string, { IPAddress: string }>;
  };
};
type SinkConnection = { remoteAddress: string; held: boolean; closed: boolean; message?: SmtpSinkMessage };
type MailRow = { id: string; status: string; attempt_count: number; lane: string; app_id: string };

export const run = async (options: ReturnType<typeof parseOptions>) => {
  for (const app of APPS) check(appIds().includes(app), `Unknown workspace app: ${app}`);
  const runId = randomBytes(4).toString("hex");
  const project = `cloud-scale-${runId}`;
  const directory = await mkdtemp(join(tmpdir(), `${project}-`));
  const tag = options.imageTag ?? `scale-${runId}`;
  const env = composeEnvironment(tag, runId);
  const envPath = join(directory, "compose.env");
  const childEnv = dockerEnvironment(process.env);
  const builtTags: string[] = [];
  const children = new Set<ReturnType<typeof Bun.spawn>>();
  const sockets = new Set<WebSocket>();
  let database: SQL | undefined;
  let shuttingDown = false;
  let cleanupPromise: Promise<void> | undefined;
  let failure: unknown;
  const docker = async (args: string[], timeoutMs = 60_000, duringCleanup = false): Promise<string> => {
    check(!shuttingDown || duringCleanup, "Scale acceptance is shutting down");
    const child = Bun.spawn(["docker", ...args], { cwd: workspaceRoot, env: childEnv, stdout: "pipe", stderr: "pipe" });
    children.add(child);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      check(!timedOut, `docker ${args[0]} timed out after ${timeoutMs} ms`);
      check(code === 0, `docker ${args[0]} failed (${code}): ${stderr.slice(-12_000)}`);
      return (args.includes("logs") ? stdout + stderr : stdout).trim();
    } finally {
      clearTimeout(timer);
      children.delete(child);
    }
  };
  const composeArgs = [
    "compose",
    "-p",
    project,
    "--project-directory",
    workspaceRoot,
    "--env-file",
    envPath,
    "-f",
    "compose.prod.yml",
    "-f",
    "compose.scale-test.yml",
    // Chat is unreleased in production. Without its profile, `down` and `logs` would skip its containers.
    "--profile",
    "unreleased",
  ];
  const compose = (args: string[], timeoutMs = 240_000) => docker([...composeArgs, ...args], timeoutMs);
  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    shuttingDown = true;
    cleanupPromise = (async () => {
      const errors: string[] = [];
      const pending = [...children];
      for (const child of pending) child.kill("SIGKILL");
      await Promise.all(pending.map((child) => child.exited));
      for (const socket of sockets) socket.close();
      try {
        await database?.close({ timeout: 2 });
      } catch (error) {
        errors.push(message(error));
      }
      try {
        await docker([...composeArgs, "down", "--volumes", "--remove-orphans", "--timeout", "10"], 180_000, true);
      } catch (error) {
        errors.push(message(error));
      }
      // Compose only removes what its active files and profiles name. Anything else labelled with the project fails the run.
      const label = `label=com.docker.compose.project=${project}`;
      for (const [kind, list, remove] of [
        ["container", ["ps", "-aq", "--filter", label], ["rm", "--force", "--volumes"]],
        ["network", ["network", "ls", "-q", "--filter", label], ["network", "rm"]],
        ["volume", ["volume", "ls", "-q", "--filter", label], ["volume", "rm", "--force"]],
      ] as const) {
        try {
          const left = (await docker([...list], 60_000, true)).split(/\s+/).filter(Boolean);
          if (!left.length) continue;
          errors.push(`${left.length} ${kind}(s) of ${project} survived compose down`);
          await docker([...remove, ...left], 60_000, true);
        } catch (error) {
          errors.push(message(error));
        }
      }
      for (const image of builtTags) {
        try {
          await docker(["image", "rm", image], 60_000, true);
        } catch (error) {
          // A build that failed before tagging left nothing to remove.
          if (!message(error).includes("No such image")) errors.push(message(error));
        }
      }
      await rm(directory, { recursive: true, force: true });
      check(errors.length === 0, `Cleanup incomplete: ${errors.join("; ")}`);
      phase("cleanup", { project });
    })();
    return cleanupPromise;
  };
  const signalHandlers = (["SIGINT", "SIGTERM"] as const).map((signal) => {
    const handler = () => {
      void cleanup()
        .catch((error) => console.error(message(error)))
        .finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
    };
    process.once(signal, handler);
    return { signal, handler };
  });
  const inspect = async (ids: string[]): Promise<Inspect[]> => (ids.length ? JSON.parse(await docker(["inspect", ...ids])) : []);
  const port = (container: Inspect, inside: number) => {
    const binding = container.NetworkSettings.Ports[`${inside}/tcp`]?.find((entry) => entry.HostIp === "127.0.0.1");
    check(binding, `No loopback port ${inside} for ${container.Id}`);
    return `http://127.0.0.1:${binding.HostPort}`;
  };
  const containers = async (service: string) => {
    const ids = (await compose(["ps", "--status", "running", "-q", service], 60_000)).split(/\s+/).filter(Boolean);
    return (await inspect(ids)).sort(
      (a, b) =>
        Number(a.Config.Labels["com.docker.compose.container-number"]) - Number(b.Config.Labels["com.docker.compose.container-number"]),
    );
  };
  const evidence = new Map<App, ReplicaEvidence>();
  const stillRunning = async (targets: Replica[], killed?: string) => {
    const states = await inspect([...new Set(targets.map((replica) => replica.id))]);
    for (const state of states) check(state.State.Running || state.Id === killed, `Target container stopped: ${state.Id}`);
    return new Set(states.filter((state) => state.State.Running).map((state) => state.Id));
  };
  const pair = (app: App) => {
    const value = evidence.get(app);
    check(value, `No replicas resolved for ${app}`);
    return value;
  };
  const served = (app: App, target: Replica) => pair(app).served.add(target.id);
  const http = async (base: string, path: string, method = "GET", body?: unknown, token?: string, expected?: number): Promise<Response> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });
    check(
      expected === undefined ? response.ok : response.status === expected,
      `${method} ${path}: expected ${expected ?? "2xx"}, got ${response.status}: ${response.ok ? "" : (await response.text()).slice(0, 1500)}`,
    );
    return response;
  };
  const request = async <T>(app: App, target: Replica, path: string, token: string, method = "GET", body?: unknown): Promise<T> => {
    const response = await http(target.url, path, method, body, token);
    const value: T = await response.json();
    served(app, target);
    return value;
  };
  const openSocket = async (app: App, target: Replica, path: string, token: string, receive: (frame: unknown) => void) => {
    // Bun extends the browser constructor with request headers.
    const candidate: unknown = Reflect.construct(WebSocket, [
      target.url.replace("http:", "ws:") + path,
      { headers: { authorization: `Bearer ${token}`, origin: ORIGIN } },
    ]);
    check(candidate instanceof WebSocket, "Bun WebSocket is unavailable");
    const socket = candidate;
    sockets.add(socket);
    let failure: string | undefined;
    socket.onmessage = (event) => {
      try {
        receive(JSON.parse(String(event.data)));
      } catch (error) {
        failure = message(error);
      }
    };
    socket.onerror = () => {
      failure = `${app} websocket failed`;
    };
    await poll(`${app} websocket open`, async () => {
      check(!failure, failure ?? "Socket failed");
      check(socket.readyState !== WebSocket.CLOSED, `${app} websocket closed`);
      return socket.readyState === WebSocket.OPEN;
    });
    return {
      socket,
      healthy: () => {
        check(!failure, failure ?? "Socket failed");
        check(socket.readyState === WebSocket.OPEN, `${app} websocket closed`);
      },
      markServed: () => served(app, target),
    };
  };
  try {
    await writeFile(envPath, envFileContents(env), { mode: 0o600 });
    const config: { networks: Record<string, { external?: boolean }> } = JSON.parse(await compose(["config", "--format", "json"], 60_000));
    check(
      Object.values(config.networks).every((network) => !network.external),
      "Scale overlay left an external network",
    );
    phase("preparing", { project, tag, replicas: options.replicas });
    for (const app of APPS) {
      const image = `ghcr.io/k2b-dev/${imageName(app)}:${tag}`;
      if (options.imageTag) {
        try {
          await docker(["image", "inspect", image]);
        } catch {
          await docker(["pull", image], 240_000);
        }
      } else {
        // Register before building so a signal immediately after completion still removes the tag.
        builtTags.push(image);
        phase("building", { app, image });
        await docker(
          [
            "build",
            "--build-arg",
            `APP_ID=${app}`,
            "--build-arg",
            "CLOUD_VERSION=0.0.0-scale",
            "--build-arg",
            `CLOUD_RELEASE=scale-${runId}`,
            "--tag",
            image,
            ".",
          ],
          20 * 60_000,
        );
      }
    }
    const infrastructure = ["postgres", "nats", "valkey", "sinks"];
    // Registries time out now and then on hosted runners; `up` itself does not retry a pull.
    for (let attempt = 1; ; attempt++) {
      try {
        await compose(["pull", "--quiet", ...infrastructure]);
        break;
      } catch (error) {
        if (attempt === 3) throw error;
        phase("pull-retry", { attempt, error: message(error) });
      }
    }
    await compose(["up", "-d", "--wait", ...infrastructure]);
    // Core alone migrates shared schemas. Each app's first instance migrates before its second starts.
    await compose(["up", "-d", "--wait", "gateway", devServiceName("core")]);
    await compose(["up", "-d", "--wait", ...SCALED_APPS.filter((app) => app !== "core").map(devServiceName)]);
    await compose([
      "up",
      "-d",
      "--wait",
      "--no-recreate",
      ...SCALED_APPS.flatMap((app) => ["--scale", `${devServiceName(app)}=${options.replicas}`]),
      ...SCALED_APPS.map(devServiceName),
    ]);
    for (const app of SCALED_APPS) {
      const resolved = await containers(devServiceName(app));
      check(resolved.length === options.replicas, `${app}: expected ${options.replicas} running containers, got ${resolved.length}`);
      const replicas = resolved.map((container) => {
        const ip = container.NetworkSettings.Networks[`${project}_cloud-internal`]?.IPAddress;
        check(ip, `${app}: missing internal network IP`);
        return {
          id: container.Id,
          ip,
          url: port(container, 3000),
          number: Number(container.Config.Labels["com.docker.compose.container-number"]),
        };
      });
      const a = replicas[0],
        b = replicas[1] ?? a;
      check(a && b && a.number === 1 && b.number === options.replicas, `${app}: unexpected Compose replica numbering`);
      evidence.set(app, { a, b, served: new Set() });
      for (const replica of replicas)
        await poll(
          `${app} replica ${replica.number} readiness`,
          async () => {
            await http(replica.url, "/_cloud/ready");
            return true;
          },
          180_000,
        );
    }
    const [gatewayContainer] = await containers(devServiceName("gateway"));
    const [sinkContainer] = await containers("sinks");
    const [postgresContainer] = await containers("postgres");
    check(gatewayContainer && sinkContainer && postgresContainer, "Infrastructure container missing");
    const gateway = port(gatewayContainer, 3000),
      sink = port(sinkContainer, 8025);
    for (const app of SCALED_APPS)
      await poll(
        `${app} gateway route`,
        async () => {
          const response = await http(gateway, app === "core" ? "/api/openapi.json" : `/api/${app}/openapi.json`);
          const document: { openapi?: string } = await response.json();
          return Boolean(document.openapi);
        },
        180_000,
      );
    phase("ready", { project, replicas: Object.fromEntries([...evidence].map(([app, value]) => [app, { a: value.a, b: value.b }])) });
    const login = async () => {
      const response = await http(gateway, "/api/auth/admin-login", "POST", { token: env.ADMIN_LOGIN_TOKEN });
      const signedIn: { session_token: string; user: { id: string } } = await response.json();
      check(signedIn.session_token && signedIn.user.id, "Admin sign-in returned no session");
      const continued = await fetch(`${gateway}/auth/continue`, {
        headers: { cookie: `session_token=${signedIn.session_token}` },
        signal: AbortSignal.timeout(10_000),
        redirect: "manual",
      });
      if (continued.ok) {
        const version = (await continued.text()).match(/data-legal-version="([a-f0-9]{64})"/)?.[1];
        check(version, "Cannot read data-legal-version from /auth/continue");
        await http(gateway, "/api/auth/legal-consent", "POST", { accepted: true, version }, signedIn.session_token);
      } else check(continued.status === 302 || continued.status === 303, `Unexpected /auth/continue status: ${continued.status}`);
      return signedIn;
    };
    const admin = await login(),
      token = admin.session_token;
    const postgresPort = new URL(port(postgresContainer, 5432)).port;
    database = new SQL(`postgres://${env.POSTGRES_USER}:${env.POSTGRES_PASSWORD}@127.0.0.1:${postgresPort}/${env.POSTGRES_DB}`, {
      max: 2,
      connectionTimeout: 5,
      idleTimeout: 5,
      connection: { statement_timeout: "10000" },
    });
    const db = database;
    const errors: string[] = [];
    const scenario = async (name: string, action: () => Promise<void>) => {
      phase(name, { status: "running" });
      try {
        await action();
      } catch (error) {
        errors.push(`${name}: ${message(error)}`);
        phase(name, { status: "failed", error: message(error) });
      }
    };
    await scenario("chat-fanout", async () => {
      const { a, b } = pair("chat");
      const frames: { t?: string; id?: string; data?: { type?: string; message?: { id: string } } }[] = [];
      const reader = await openSocket("chat", b, "/api/chat/live", token, (frame) => {
        check(typeof frame === "object" && frame !== null, "Invalid Chat frame");
        frames.push(frame);
      });
      try {
        const created = await request<{ conversation: { id: string } }>("chat", a, "/api/chat/conversations", token, "POST", {
          name: `Scale ${runId}`,
          members: [],
          allowDuplicate: true,
        });
        const id = created.conversation.id;
        reader.socket.send(JSON.stringify({ t: "sub", id: "scale", channel: "conversation", scope: { conversation: id } }));
        await poll("Chat subscription ready on B", async () => {
          reader.healthy();
          return frames.some((frame) => frame.id === "scale" && frame.t === "ready");
        });
        reader.markServed();
        const sent = await request<{ id: string }>("chat", a, `/api/chat/conversations/${id}/messages`, token, "POST", {
          clientId: crypto.randomUUID(),
          body: `scale-${runId}`,
        });
        await poll("Chat message on B", async () => {
          reader.healthy();
          return frames.some(
            (frame) => frame.id === "scale" && frame.t === "event" && frame.data?.type === "message" && frame.data.message?.id === sent.id,
          );
        });
        await stillRunning([a, b]);
        check(
          frames.some(
            (frame) => frame.id === "scale" && frame.t === "event" && frame.data?.type === "message" && frame.data.message?.id === sent.id,
          ),
          "B did not receive the exact Chat message",
        );
        phase("chat-fanout", { status: "passed", messageId: sent.id, writer: a.id, reader: b.id });
      } finally {
        reader.socket.close();
      }
    });
    await scenario("notebooks-fanout", async () => {
      const { a, b } = pair("notebooks");
      const notebook = await request<{ id: string }>("notebooks", a, "/api/notebooks", token, "POST", {
        name: `Scale ${runId}`,
        welcomeNote: false,
      });
      const note = await request<{ id: string }>("notebooks", a, `/api/notebooks/${notebook.id}/notes`, token, "POST", { contentMd: "" });
      const docs = [new Y.Doc(), new Y.Doc()];
      const clients: Awaited<ReturnType<typeof openSocket>>[] = [];
      try {
        for (const [index, replica] of [a, b].entries()) {
          const doc = docs[index];
          check(doc, "Missing Yjs document");
          let ready = false;
          const reader = await openSocket("notebooks", replica, "/api/notebooks/ws", token, (raw) => {
            check(typeof raw === "object" && raw !== null && "type" in raw && "payload" in raw, "Invalid Notebooks frame");
            const payload = raw.payload;
            check(typeof payload === "object" && payload !== null, "Missing Notebooks payload");
            if (raw.type === "notes.yjs.error") throw new Error(`Notebooks rejected client: ${JSON.stringify(payload)}`);
            if (raw.type === "notes.yjs.replay.ready") ready = true;
            if (raw.type === "notes.yjs.sync.push" && "updates" in payload) {
              check(Array.isArray(payload.updates), "Missing Yjs updates");
              for (const update of payload.updates) {
                check(typeof update === "object" && update !== null && typeof update.payload === "string", "Invalid Yjs update");
                Y.applyUpdate(doc, Buffer.from(update.payload, "base64"), "remote");
              }
            }
          });
          clients.push(reader);
          reader.socket.send(JSON.stringify({ type: "notes.yjs.replay.request", payload: { noteId: note.id, fromCursor: null } }));
          await poll(`Notebooks replica ${replica.number} replay ready`, async () => {
            reader.healthy();
            return ready;
          });
          reader.markServed();
        }
        const [docA, docB] = docs,
          writer = clients[0];
        check(docA && docB && writer, "Missing Yjs clients");
        const marker = `scale-yjs-${runId}`;
        const state = Y.encodeStateVector(docA);
        docA.getText("codemirror").insert(docA.getText("codemirror").length, marker);
        writer.socket.send(
          JSON.stringify({
            type: "notes.yjs.sync.publish",
            payload: { noteId: note.id, payload: Buffer.from(Y.encodeStateAsUpdate(docA, state)).toString("base64") },
          }),
        );
        await poll("Yjs convergence on B", async () => {
          for (const client of clients) client.healthy();
          return docB.getText("codemirror").toString().includes(marker);
        });
        await stillRunning([a, b]);
        check(docB.getText("codemirror").toString() === docA.getText("codemirror").toString(), "Yjs documents did not converge");
        phase("notebooks-fanout", { status: "passed", note: note.id, marker, writer: a.id, reader: b.id });
      } finally {
        for (const client of clients) client.socket.close();
      }
    });
    const { a: coreA, b: coreB } = pair("core");
    await request("core", coreA, "/api/admin/core/outgoing-mail/profiles/scale", token, "PUT", {
      name: "Scale acceptance",
      fromAddress: "scale@example.test",
      fromName: null,
      smtpHost: "sinks",
      smtpPort: 2525,
      smtpSecure: false,
      smtpUser: null,
      smtpPassword: null,
      pacePerMinute: 60,
      dailyRecipientLimit: null,
      maxAttachmentBytes: 15728640,
    });
    const trigger = async (target: Replica, label: string) => {
      const recipient = `scale-${label}-${runId}@example.test`;
      // Seed only the account; authentication and notification delivery still use the public API.
      await db`INSERT INTO auth.users (uid, provider, profile, mail) VALUES (${`scale-${label}-${runId}`}, 'local', 'user', ${recipient})`;
      await request("core", target, "/api/auth/email-login", token, "POST", { email: recipient, category: "login" });
      return recipient;
    };
    const mailRows = (recipient: string) =>
      db<MailRow[]>`SELECT id, status, attempt_count, lane, app_id FROM outgoing_mail.messages WHERE ${recipient} = ANY(to_addresses)`;
    const sinkMessages = async (recipient: string): Promise<SmtpSinkMessage[]> => {
      const rows: SmtpSinkMessage[] = await (await http(sink, "/messages")).json();
      return rows.filter((row) => row.to.includes(recipient));
    };
    const normalizeIp = (ip: string) => ip.replace(/^::ffff:/, "");
    const coreForPeer = (peer: string) => {
      const core = [coreA, coreB].find((replica) => replica.ip === normalizeIp(peer));
      check(core, `SMTP peer ${peer} is not a Core replica`);
      served("core", core);
      return core;
    };
    const sentOnce = async (recipient: string, attempts: number, timeoutMs: number) => {
      const row = await poll(
        "Durable outgoing mail sent",
        async () => {
          const messages = await sinkMessages(recipient);
          check(messages.length <= 1, `Duplicate SMTP delivery to ${recipient}`);
          const rows = await mailRows(recipient);
          check(rows.length <= 1, `Duplicate durable mail row for ${recipient}`);
          const current = rows[0];
          check(!current || !["failed", "cancelled", "bounced"].includes(current.status), `Outgoing mail ended in ${current?.status}`);
          return current?.status === "sent" ? current : undefined;
        },
        timeoutMs,
      );
      await stillRunning([coreA, coreB], killedCore);
      const accepted = await sinkMessages(recipient);
      check(accepted.length === 1, `Expected exactly one SMTP acceptance, got ${accepted.length}`);
      check(
        row.attempt_count === attempts && row.app_id === "core" && row.lane === "immediate",
        `Expected Core immediate job with attempt_count ${attempts}: ${JSON.stringify(row)}`,
      );
      const delivery = accepted[0];
      check(delivery, "Missing accepted mail");
      return { row, deliveredBy: coreForPeer(delivery.remoteAddress) };
    };
    let killedCore: string | undefined;
    await scenario("durable-mail-once", async () => {
      await http(sink, "/reset", "POST");
      const recipient = await trigger(coreB, "once");
      const result = await sentOnce(recipient, 1, 90_000);
      phase("durable-mail-once", { status: "passed", trigger: "POST /api/auth/email-login", recipient, ...result });
    });
    let draftPath = "",
      leaseToken = "",
      holderId = "";
    await scenario("mail-draft-lease", async () => {
      const { a, b } = pair("mail");
      const mailbox = await request<{ id: string }>("mail", a, "/api/mail/mailboxes", token, "POST", {
        name: `Scale ${runId}`,
        description: "Disposable lease acceptance",
      });
      const identityId = randomBytes(3).toString("hex");
      // A draft only needs a verified identity, not an IMAP server or provider binding.
      await db`INSERT INTO mail.sender_identities (short_id, mailbox_id, label, display_name, from_address, automation_policy, is_default, status)
        SELECT ${identityId}, id, 'Scale', 'Scale', 'sender@example.test', 'disabled', true, 'verified' FROM mail.mailboxes WHERE short_id = ${mailbox.id}`;
      const draft = await request<{ id: string; revision: number }>("mail", a, `/api/mail/mailboxes/${mailbox.id}/drafts`, token, "POST", {
        senderIdentityId: identityId,
        subject: `Scale ${runId}`,
        body: "before",
      });
      draftPath = `/api/mail/mailboxes/${mailbox.id}/drafts/${draft.id}`;
      const lease = await request<{ token: string; holder: { id: string } }>("mail", a, `${draftPath}/lease`, token, "POST", {});
      leaseToken = lease.token;
      holderId = lease.holder.id;
      const body = `saved-on-B-${runId}`;
      const saved = await request<{ revision: number }>("mail", b, draftPath, token, "PUT", {
        expectedRevision: draft.revision,
        draft: { senderIdentityId: identityId, subject: `Scale ${runId}`, body },
      });
      const heartbeat = await request<{ token: string; holder: { id: string } }>("mail", b, `${draftPath}/lease`, token, "PUT", {
        token: leaseToken,
      });
      const read = await request<{ body: string; revision: number }>("mail", a, draftPath, token);
      const currentLease = await request<{ holder: { id: string }; acquiredAt: string }>("mail", a, `${draftPath}/lease`, token);
      await stillRunning([a, b]);
      check(read.body === body && read.revision === saved.revision, "A did not read B's saved draft revision");
      check(heartbeat.token === leaseToken && currentLease.holder.id === holderId, "Draft lease changed across replicas");
      phase("mail-draft-lease", {
        status: "passed",
        draft: draft.id,
        revision: read.revision,
        holder: holderId,
        acquire: a.id,
        saveAndHeartbeat: b.id,
        saveContract: "expectedRevision; lease ownership is by user",
      });
    });
    await scenario("mail-lease-conflict", async () => {
      check(draftPath && leaseToken, "Draft lease scenario did not create a held lease");
      const { a, b } = pair("mail");
      try {
        const second = await login();
        check(second.session_token !== token, "Second admin sign-in reused the first session");
        await http(b.url, `${draftPath}/lease`, "POST", {}, second.session_token, 409);
        served("mail", b);
        const holder = await request<{ holder: { id: string; displayName: string } }>(
          "mail",
          b,
          `${draftPath}/lease`,
          second.session_token,
        );
        await stillRunning([a, b]);
        check(holder.holder.id === holderId && holderId === admin.user.id, "Conflict did not retain the holder acquired on A");
        phase("mail-lease-conflict", {
          status: "passed",
          statusCode: 409,
          holder: holder.holder,
          acquire: a.id,
          conflict: b.id,
          contender: "same user, second session",
        });
      } finally {
        await http(a.url, `${draftPath}/lease`, "DELETE", { token: leaseToken }, token);
      }
    });
    // Run last: the intentionally killed replica must not invalidate earlier scenario checks.
    await scenario("sigkill-mail-recovery", async () => {
      if (options.replicas === 1) {
        phase("sigkill-mail-recovery", {
          status: "skipped",
          reason: "Negative control has no surviving Core replica; final vacuity guard will fail",
        });
        return;
      }
      await stillRunning([coreA, coreB]);
      await http(sink, "/reset", "POST");
      await http(sink, "/hold", "POST");
      try {
        const recipient = await trigger(coreA, "recovery");
        const held = await poll(
          "SMTP held at end of DATA",
          async () => {
            const connections: SinkConnection[] = await (await http(sink, "/connections")).json();
            return connections.find((connection) => connection.held && !connection.closed && connection.message?.to.includes(recipient));
          },
          90_000,
        );
        const victim = coreForPeer(held.remoteAddress),
          survivor = victim.id === coreA.id ? coreB : coreA;
        await stillRunning([victim, survivor]);
        const [sending] = await mailRows(recipient);
        check(sending?.status === "sending" && sending.attempt_count === 1, "Held mail is not on its first durable sending attempt");
        check((await sinkMessages(recipient)).length === 0, "Held DATA was already accepted");
        await docker(["update", "--restart=no", victim.id]);
        await docker(["kill", "--signal", "KILL", victim.id]);
        killedCore = victim.id;
        await http(sink, "/release", "POST");
        phase("sigkill-mail-recovery", {
          status: "waiting",
          victim: victim.id,
          survivor: survivor.id,
          deadlineMs: 8 * 60_000,
          reason: "Core recovers sending rows after five minutes, scanning every 30 seconds",
        });
        const result = await sentOnce(recipient, 2, 8 * 60_000);
        await stillRunning([survivor]);
        check(result.deliveredBy.id === survivor.id, "Recovery did not deliver from the other Core replica");
        const [dead] = await inspect([victim.id]);
        check(dead && !dead.State.Running, "Killed Core restarted; recovery proof is invalid");
        phase("sigkill-mail-recovery", { status: "passed", recipient, victim: victim.id, ...result });
      } finally {
        await http(sink, "/release", "POST");
      }
    });
    for (const app of SCALED_APPS) {
      const current = pair(app);
      const running = await stillRunning([current.a, current.b], killedCore);
      assertBothReplicasServed(devServiceName(app), current, running, killedCore);
    }
    check(errors.length === 0, errors.join("\n"));
    phase("passed", { project, bothReplicasServed: Object.fromEntries([...evidence].map(([app, value]) => [app, [...value.served]])) });
  } catch (error) {
    // Compose logs prefixes identify every replica, including the deliberately stopped one.
    try {
      console.error(await compose(["logs", "--no-color", "--tail", "200"], 60_000));
    } catch (logsError) {
      console.error(`Cannot collect logs: ${message(logsError)}`);
    }
    failure = error;
    throw error;
  } finally {
    try {
      await cleanup();
    } catch (error) {
      // Keep the original failure as the result; a cleanup problem is still reported.
      if (failure === undefined) throw error;
      console.error(message(error));
    } finally {
      for (const { signal, handler } of signalHandlers) process.removeListener(signal, handler);
    }
  }
};

if (import.meta.main) {
  try {
    const options = parseOptions(Bun.argv.slice(2));
    if (options.help) console.log(HELP);
    else {
      const leak = dotenvLeak(process.cwd(), process.execArgv);
      check(!leak, `Refusing dotenv input (${leak}). Run bun --no-env-file scripts/scale-acceptance.ts`);
      runUnderHeavyLock();
      await run(options);
    }
  } catch (error) {
    phase("failed", { error: message(error) });
    process.exitCode = 1;
  }
}
