import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

type Trace = {
  at: number;
  stage: string;
  updateId?: string;
  peerId?: string;
  role?: string;
  durationMs?: number;
  outcome?: "ok" | "error";
  errorName?: string;
  events?: number;
  originPeerId?: string | null;
};
/** Fixed histograms plus at most 8192 correlated edits (eight peers each), independent of run duration. */
export async function report(out: string) {
  let incompleteLines = 0;
  const operations: Record<string, { ok: number; failed: number; unknown: number; events: number; errors: Record<string, number> }> = {};
  const histograms = new Map<string, Uint32Array>();
  const add = (name: string, ms: number) => {
    if (ms < 0 || !Number.isFinite(ms)) return;
    let h = histograms.get(name);
    if (!h) {
      h = new Uint32Array(6001);
      histograms.set(name, h);
    }
    h[Math.min(6000, Math.floor(ms / 10))]!++;
  };
  // One-ms signed histograms preserve fan-out arriving before the publishing node sees its ack.
  const breakdownHistograms = new Map<string, Uint32Array>();
  const addStep = (name: string, ms: number) => {
    if (!Number.isFinite(ms)) return;
    let h = breakdownHistograms.get(name);
    if (!h) {
      h = new Uint32Array(120001);
      breakdownHistograms.set(name, h);
    }
    h[Math.max(0, Math.min(120000, Math.ceil(ms) + 60000))]!++;
  };
  const ids = new Set<string>();
  const contexts = new Map<string, Map<string, number>>();
  const heads = new Map<string, number>();
  const publications = new Map<string, number>();
  const received = new Map<string, number>();
  const nodes = new Map<string, number>();
  const fanouts = new Map<string, number>();
  const sends = new Map<string, number>();
  const clientReceives = new Map<string, number>();
  const each = async (file: string, read: (e: Trace) => void) => {
    if (!(await Bun.file(file).exists())) return;
    for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
      let event: Trace;
      try {
        event = JSON.parse(line);
      } catch {
        incompleteLines++;
        continue;
      }
      read(event);
    }
  };
  // Select edits from the client first: selecting while reading node 1 loses
  // node 1's deliveries of edits first admitted on node 2.
  await each(`${out}/client-trace.ndjson`, (e) => {
    if (e.stage !== "client_send" || !e.updateId || !e.peerId) return;
    if (ids.size < 8192) ids.add(e.updateId);
    if (ids.has(e.updateId) && !sends.has(`${e.updateId}|${e.peerId}`)) sends.set(`${e.updateId}|${e.peerId}`, e.at);
  });
  for (const [node, serverPath] of [out, `${out}/node-2`].entries())
    await each(`${serverPath}/server-trace.ndjson`, (e) => {
      if (e.role === "ingress" && e.durationMs !== undefined) {
        add(e.stage, e.durationMs);
        operations[e.stage] ??= { ok: 0, failed: 0, unknown: 0, events: 0, errors: {} };
        const operation = operations[e.stage]!;
        operation.events += e.events ?? 0;
        if (e.outcome === "ok") {
          operation.ok++;
          if (e.stage === "jetstream_publish_ack:end") addStep("jetstream_publish_ack_duration", e.durationMs);
        } else if (e.outcome === "error") {
          operation.failed++;
          const name = e.errorName ?? "UnknownError";
          operation.errors[name] = (operation.errors[name] ?? 0) + 1;
        } else operation.unknown++;
      }
      if (!e.updateId || !ids.has(e.updateId)) return;
      if (e.stage === "broker_fanout") {
        const key = `${e.updateId}|${node}`;
        if (!fanouts.has(key)) fanouts.set(key, e.at);
      }
      if (!e.peerId) return;
      nodes.set(e.peerId, node);
      const key = `${e.updateId}|${e.peerId}|${e.role}`;
      if (e.stage === "broker_lookup:end") heads.set(key, e.at);
      if (e.stage === "jetstream_publish_ack:start") {
        const head = heads.get(key);
        if (head !== undefined) add("head_to_publish", e.at - head);
        heads.delete(key);
      }
      let g = contexts.get(key);
      if (!g) {
        g = new Map();
        contexts.set(key, g);
      }
      // Keep first arrival/start timestamps; only a successful publish end is durable.
      if (!g.has(e.stage) && (e.stage !== "jetstream_publish_ack:end" || e.outcome === "ok")) g.set(e.stage, e.at);
      if (e.stage === "jetstream_publish_ack:end" && e.outcome === "ok" && !publications.has(e.updateId))
        publications.set(e.updateId, e.at);
      if (e.stage === "socket_receive" && !received.has(`${e.updateId}|${e.peerId}`)) received.set(`${e.updateId}|${e.peerId}`, e.at);
    });
  for (const [key, g] of contexts) {
    const delivery = key.endsWith("|delivery");
    const pairs = delivery
      ? [
          ["delivery_queue", "fanout_received", "sql_pool_wait:start"],
          ["delivery_fence", "sql_operation_start", "fanout_emit"],
          ["fanout_wait_and_fence", "fanout_received", "fanout_fence_acquired"],
          ["fanout_to_emit", "fanout_received", "fanout_emit"],
        ]
      : [
          ["socket_queue", "socket_receive", "handler_start"],
          ["handler_total", "handler_start", "handler_end"],
          ["transaction_setup", "sql_setup_start", "sql_operation_start"],
          ["commit", "sql_operation_end", "sql_released"],
          ["before_publish", "accept_start", "jetstream_publish_ack:start"],
        ];
    for (const [name, a, b] of pairs) {
      const start = g.get(a!),
        end = g.get(b!);
      if (start !== undefined && end !== undefined) add(name!, end - start);
    }
    const publication = publications.get(key.split("|")[0]!);
    const arrival = g.get("fanout_received");
    if (delivery && publication !== undefined && arrival !== undefined) add("ack_to_fanout", arrival - publication);
  }
  for (const [key, sentAt] of sends) {
    const [updateId, peerId] = key.split("|");
    const ingress = contexts.get(`${key}|ingress`);
    const receive = received.get(key);
    const publish = ingress?.get("jetstream_publish_ack:start");
    const ack = publications.get(updateId!);
    if (receive !== undefined) addStep("server_receive_from_send", receive - sentAt);
    if (publish !== undefined) {
      addStep("publish_from_send", publish - sentAt);
      if (receive !== undefined) addStep("receive_to_publish", publish - receive);
    }
    if (ack !== undefined) addStep("jetstream_ack_from_send", ack - sentAt);
    for (const node of [0, 1]) {
      const arrival = fanouts.get(`${updateId}|${node}`);
      if (arrival === undefined || nodes.get(peerId!) === undefined) continue;
      const location = nodes.get(peerId!) === node ? "same_node" : "other_node";
      addStep(`broker_fanout_${location}_from_send`, arrival - sentAt);
      if (ack !== undefined) addStep(`ack_to_broker_fanout_${location}`, arrival - ack);
    }
  }
  const observations: Array<{ updateId: string; source: string; target: string; sentAt: number; appliedAt: number; latencyMs: number }> =
    [];
  await each(`${out}/client-trace.ndjson`, (e) => {
    if (!e.updateId || !ids.has(e.updateId)) return;
    const key = `${e.updateId}|${e.peerId}`;
    if (e.stage === "client_send") {
      const arrival = received.get(key);
      if (arrival !== undefined) add("client_to_receive", arrival - e.at);
    }
    if (e.stage === "client_send:end" && e.durationMs !== undefined) addStep("client_send_duration", e.durationMs);
    if (e.stage === "client_receive") clientReceives.set(key, e.at);
    if (e.stage === "durable_ack") {
      const start = sends.get(key);
      if (start !== undefined) add("durable_ack", e.at - start);
    }
    if (e.stage === "peer_apply") {
      const sentAt = e.originPeerId ? sends.get(`${e.updateId}|${e.originPeerId}`) : undefined;
      if (sentAt !== undefined && e.peerId && e.originPeerId && e.peerId !== e.originPeerId && observations.length < 8192)
        observations.push({
          updateId: e.updateId,
          source: e.originPeerId,
          target: e.peerId,
          sentAt,
          appliedAt: e.at,
          latencyMs: e.at - sentAt,
        });
      if (sentAt !== undefined && e.peerId !== e.originPeerId) add("send_to_peer_apply", e.at - sentAt);
      const start = contexts.get(`${key}|delivery`)?.get("peer_send");
      if (start !== undefined) add("send_to_apply", e.at - start);
      const sourceNode = e.originPeerId ? nodes.get(e.originPeerId) : undefined;
      const targetNode = nodes.get(e.peerId ?? "");
      if (sentAt !== undefined && sourceNode !== undefined && targetNode !== undefined && e.peerId !== e.originPeerId) {
        const location = sourceNode === targetNode ? "same_node" : "other_node";
        addStep(`client_apply_${location}_from_send`, e.at - sentAt);
        const arrival = fanouts.get(`${e.updateId}|${targetNode}`);
        const clientReceive = clientReceives.get(key);
        if (start !== undefined) {
          addStep(`server_socket_send_${location}_from_send`, start - sentAt);
          if (arrival !== undefined) addStep(`broker_fanout_to_socket_send_${location}`, start - arrival);
          if (clientReceive !== undefined) addStep(`socket_send_to_client_receive_${location}`, clientReceive - start);
        }
        if (clientReceive !== undefined) addStep("client_receive_to_apply", e.at - clientReceive);
        if (e.durationMs !== undefined) addStep("client_yjs_apply", e.durationMs);
      }
    }
  });
  observations.sort((a, b) => a.latencyMs - b.latencyMs);
  const representative = observations[Math.floor(observations.length / 2)];
  if (representative) {
    const timeline = [
      { role: "client", stage: "client_send", offsetMs: 0 },
      ...["ingress", "delivery"].flatMap((role) =>
        [
          ...(contexts.get(`${representative.updateId}|${role === "ingress" ? representative.source : representative.target}|${role}`) ??
            []),
        ].map(([stage, at]) => ({ role, stage, offsetMs: at - representative.sentAt })),
      ),
      ...[0, 1].flatMap((node) => {
        const at = fanouts.get(`${representative.updateId}|${node}`);
        return at === undefined ? [] : [{ role: `node-${node + 1}`, stage: "broker_fanout", offsetMs: at - representative.sentAt }];
      }),
      { role: "client", stage: "peer_apply", offsetMs: representative.latencyMs },
    ].sort((a, b) => a.offsetMs - b.offsetMs);
    await Bun.write(`${out}/representative-edit.json`, JSON.stringify({ ...representative, timeline }, null, 2));
  }
  const stages = Object.fromEntries(
    [...histograms].map(([name, h]) => {
      const samples = h.reduce((a, b) => a + b, 0);
      const percentile = (p: number) => {
        let sum = 0;
        for (let i = 0; i < h.length; i++) {
          sum += h[i]!;
          if (sum >= samples * p) return (i + 1) * 10;
        }
        return null;
      };
      return [name, { samples, p50Ms: percentile(0.5), p95Ms: percentile(0.95) }];
    }),
  );
  const steps = Object.fromEntries(
    [...breakdownHistograms].map(([name, h]) => {
      const samples = h.reduce((a, b) => a + b, 0);
      const percentile = (p: number) => {
        let sum = 0;
        for (let i = 0; i < h.length; i++) {
          sum += h[i]!;
          if (sum >= samples * p) return i - 60000;
        }
        return null;
      };
      return [name, { samples, p50Ms: percentile(0.5), p95Ms: percentile(0.95) }];
    }),
  );
  const result = {
    incompleteLines,
    correlatedEdits: ids.size,
    correlationLimit: 8192,
    correlationSelection: "first 8192 client-sent update IDs; includes the SQL probe and reconnect replay",
    bucketMs: 10,
    operations,
    stages,
    breakdown: { bucketMs: 1, clippedAtMs: [-60000, 60000], clock: "same-host process epoch milliseconds", steps },
  };
  await Bun.write(`${out}/stages.json`, JSON.stringify(result, null, 2));
  return result;
}
