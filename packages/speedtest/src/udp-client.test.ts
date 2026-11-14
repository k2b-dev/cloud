import { expect, test } from "bun:test";
import { createUdpHandler, UDP_HELLO } from "./udp";
import { runUdpTest } from "./udp-client";

test("the explicit UDP diagnostic completes its handshake and counts twenty replies", async () => {
  const handler = createUdpHandler({ maxPeers: 4, now: () => Date.parse("2026-10-15T09:30:00Z"), secret: new Uint8Array(32).fill(7) });
  const socket = await Bun.udpSocket({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(server, packet, port, address) {
        const reply = handler(packet, address, port);
        if (reply) server.send(reply, port, address);
      },
    },
  });
  try {
    const result = await runUdpTest("http://127.0.0.1", { port: socket.port });
    expect(result.sent).toBe(20);
    expect(result.received).toBe(20);
    expect(result.packet_loss_percent).toBe(0);
    expect(result.ping_ms).toBeGreaterThanOrEqual(0);
    expect(result.jitter_ms).toBeGreaterThanOrEqual(0);
  } finally {
    socket.close();
  }
});
test("packet loss after a successful UDP handshake remains a result", async () => {
  const handler = createUdpHandler({ maxPeers: 4, now: () => Date.parse("2026-10-15T09:30:00Z"), secret: new Uint8Array(32).fill(7) });
  const socket = await Bun.udpSocket({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(server, packet, port, address) {
        if (packet[0] !== UDP_HELLO) return;
        const reply = handler(packet, address, port);
        if (reply) server.send(reply, port, address);
      },
    },
  });
  try {
    const result = await runUdpTest("http://127.0.0.1", { port: socket.port });
    expect(result.received).toBe(0);
    expect(result.packet_loss_percent).toBe(100);
    expect(result.ping_ms).toBeNull();
    expect(result.jitter_ms).toBeNull();
  } finally {
    socket.close();
  }
});
test("UDP honours cancellation before opening a socket", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await expect(runUdpTest("http://127.0.0.1", { signal: controller.signal })).rejects.toThrow("cancelled");
});

test("150 ms replies are latency, not packet loss", async () => {
  const handler = createUdpHandler({ maxPeers: 4, now: () => Date.parse("2026-10-15T09:30:00Z"), secret: new Uint8Array(32).fill(7) });
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const socket = await Bun.udpSocket({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(server, packet, port, address) {
        const reply = handler(packet, address, port);
        if (!reply) return;
        const timer = setTimeout(() => {
          timers.delete(timer);
          server.send(reply, port, address);
        }, 150);
        timers.add(timer);
      },
    },
  });
  try {
    const result = await runUdpTest("http://127.0.0.1", { port: socket.port });
    expect(result.sent).toBe(20);
    expect(result.received).toBe(20);
    expect(result.packet_loss_percent).toBe(0);
    expect(result.ping_ms).toBeGreaterThanOrEqual(140);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    socket.close();
  }
});
