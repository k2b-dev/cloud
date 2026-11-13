import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { report } from "./report";

test("stage report correlates separate process clocks and reports incomplete trace lines", async () => {
  const out = await mkdtemp(join(tmpdir(), "mail-draft-stages-"));
  const lines = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  try {
    await mkdir(`${out}/node-2`);
    await Bun.write(
      `${out}/server-trace.ndjson`,
      lines([
        { at: 110, stage: "socket_receive", updateId: "one", peerId: "author", role: "ingress" },
        { at: 120, stage: "handler_start", updateId: "one", peerId: "author", role: "ingress" },
        { at: 130, stage: "broker_lookup:end", updateId: "one", peerId: "author", role: "ingress", durationMs: 5, outcome: "ok" },
        { at: 150, stage: "jetstream_publish_ack:start", updateId: "one", peerId: "author", role: "ingress" },
        { at: 200, stage: "jetstream_publish_ack:end", updateId: "one", peerId: "author", role: "ingress", durationMs: 4, outcome: "ok" },
        {
          at: 204,
          stage: "jetstream_publish_ack:end",
          updateId: "one",
          peerId: "author",
          role: "ingress",
          durationMs: 4,
          outcome: "error",
          errorName: "ConflictError",
        },
        {
          at: 195,
          stage: "broker_replay:end",
          updateId: "one",
          peerId: "author",
          role: "ingress",
          durationMs: 10,
          outcome: "ok",
          events: 2,
        },
        { at: 198, stage: "broker_fanout", updateId: "one", role: "delivery" },
        { at: 310, stage: "broker_fanout", updateId: "two", role: "delivery" },
        { at: 312, stage: "peer_send", updateId: "two", peerId: "author", role: "delivery" },
        { at: 205, stage: "fanout_received", updateId: "one", peerId: "peer", role: "delivery" },
        { at: 207, stage: "peer_send", updateId: "one", peerId: "peer", role: "delivery" },
      ]) + "{partial",
    );
    await Bun.write(
      `${out}/node-2/server-trace.ndjson`,
      lines([
        { at: 202, stage: "broker_fanout", updateId: "one", role: "delivery" },
        { at: 207, stage: "peer_send", updateId: "one", peerId: "peer", role: "delivery" },
        { at: 251, stage: "socket_receive", updateId: "two", peerId: "peer", role: "ingress" },
      ]),
    );
    await Bun.write(
      `${out}/client-trace.ndjson`,
      lines([
        { at: 100, stage: "client_send", updateId: "one", peerId: "author" },
        { at: 101, stage: "client_send:end", updateId: "one", peerId: "author", durationMs: 0.25 },
        { at: 209, stage: "client_receive", updateId: "one", peerId: "peer", originPeerId: "author" },
        { at: 211, durationMs: 0.3, stage: "peer_apply", updateId: "one", peerId: "peer", originPeerId: "author" },
        { at: 220, stage: "durable_ack", updateId: "one", peerId: "author" },
        { at: 250, stage: "client_send", updateId: "two", peerId: "peer" },
        { at: 314, stage: "client_receive", updateId: "two", peerId: "author", originPeerId: "peer" },
        { at: 320, durationMs: 0.4, stage: "peer_apply", updateId: "two", peerId: "author", originPeerId: "peer" },
      ]),
    );
    const result = await report(out);
    expect(await Bun.file(`${out}/representative-edit.json`).json()).toMatchObject({
      updateId: "one",
      source: "author",
      target: "peer",
      latencyMs: 111,
      timeline: expect.arrayContaining([
        { role: "client", stage: "client_send", offsetMs: 0 },
        { role: "client", stage: "peer_apply", offsetMs: 111 },
      ]),
    });
    expect(result.incompleteLines).toBe(1);
    expect(result.correlatedEdits).toBe(2);
    expect(result.operations["jetstream_publish_ack:end"]).toMatchObject({ ok: 1, failed: 1, errors: { ConflictError: 1 } });
    expect(result.operations["broker_replay:end"]).toMatchObject({ ok: 1, events: 2 });
    expect(result.stages.head_to_publish).toMatchObject({ samples: 1, p50Ms: 30 });
    expect(result.stages.send_to_peer_apply).toMatchObject({ samples: 2, p50Ms: 80, p95Ms: 120 });
    expect(result.stages.durable_ack).toMatchObject({ samples: 1, p50Ms: 130 });
    expect(result.stages.client_to_receive).toMatchObject({ samples: 2, p50Ms: 10, p95Ms: 20 });
    expect(result.stages.ack_to_fanout).toMatchObject({ samples: 1, p50Ms: 10 });
    expect(result.stages.send_to_apply).toMatchObject({ samples: 2, p50Ms: 10 });
    expect(result.breakdown.steps).toMatchObject({
      client_send_duration: { samples: 1, p50Ms: 1 },
      server_receive_from_send: { samples: 2, p50Ms: 1, p95Ms: 10 },
      publish_from_send: { samples: 1, p50Ms: 50 },
      jetstream_ack_from_send: { samples: 1, p50Ms: 100 },
      jetstream_publish_ack_duration: { samples: 1, p50Ms: 4 },
      broker_fanout_same_node_from_send: { samples: 1, p50Ms: 98 },
      broker_fanout_other_node_from_send: { samples: 2, p50Ms: 60, p95Ms: 102 },
      ack_to_broker_fanout_same_node: { samples: 1, p50Ms: -2 },
      ack_to_broker_fanout_other_node: { samples: 1, p50Ms: 2 },
      broker_fanout_to_socket_send_other_node: { samples: 2, p50Ms: 2, p95Ms: 5 },
      socket_send_to_client_receive_other_node: { samples: 2, p50Ms: 2 },
      client_receive_to_apply: { samples: 2, p50Ms: 2, p95Ms: 6 },
      client_yjs_apply: { samples: 2, p50Ms: 1 },
    });
  } finally {
    for (const name of ["server-trace.ndjson", "client-trace.ndjson", "stages.json", "representative-edit.json"])
      await unlink(`${out}/${name}`);
    await unlink(`${out}/node-2/server-trace.ndjson`);
    await rmdir(`${out}/node-2`);
    await rmdir(out);
  }
});
