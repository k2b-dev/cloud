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
  const ids = new Set<string>();
  const contexts = new Map<string, Map<string, number>>();
  const heads = new Map<string, number>();
  const publications = new Map<string, number>();
  const received = new Map<string, number>();
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
  for (const serverPath of [out, `${out}/node-2`])
    await each(`${serverPath}/server-trace.ndjson`, (e) => {
      if (e.role === "ingress" && e.durationMs !== undefined) {
        add(e.stage, e.durationMs);
        operations[e.stage] ??= { ok: 0, failed: 0, unknown: 0, events: 0, errors: {} };
        const operation = operations[e.stage]!;
        operation.events += e.events ?? 0;
        if (e.outcome === "ok") operation.ok++;
        else if (e.outcome === "error") {
          operation.failed++;
          const name = e.errorName ?? "UnknownError";
          operation.errors[name] = (operation.errors[name] ?? 0) + 1;
        } else operation.unknown++;
      }
      if (!e.updateId || !e.peerId) return;
      if (e.stage === "socket_receive" && ids.size < 8192) ids.add(e.updateId);
      if (!ids.has(e.updateId)) return;
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
      // First reservation belongs to admission; a second one fences the durable notification.
      if (!g.has(e.stage)) g.set(e.stage, e.at);
      if (e.stage === "jetstream_publish_ack:end" && e.outcome === "ok") publications.set(e.updateId, e.at);
      if (e.stage === "socket_receive") received.set(`${e.updateId}|${e.peerId}`, e.at);
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
  const sends = new Map<string, number>();
  const observations: Array<{ updateId: string; source: string; target: string; sentAt: number; appliedAt: number; latencyMs: number }> =
    [];
  await each(`${out}/client-trace.ndjson`, (e) => {
    if (!e.updateId || !ids.has(e.updateId)) return;
    const key = `${e.updateId}|${e.peerId}`;
    if (e.stage === "client_send") {
      sends.set(key, e.at);
      const arrival = received.get(key);
      if (arrival !== undefined) add("client_to_receive", arrival - e.at);
    }
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
  const result = { incompleteLines, correlatedEdits: ids.size, correlationLimit: 8192, bucketMs: 10, operations, stages };
  await Bun.write(`${out}/stages.json`, JSON.stringify(result, null, 2));
  return result;
}
