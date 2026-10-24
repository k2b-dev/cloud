import { describe, expect, jest, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, ServerResponse } from "node:http";
import type { RequestOptions } from "node:https";
import type { RequestDetails } from "web-push";
import { networkTransportFixture } from "../../../../../scripts/fixtures/network-transport";
import { buildPinnedWebPushRequests, sendPinnedWebPush } from "./web-push-transport";

const subscription = {
  endpoint: "https://push.example.test/subscriptions/one?token=two",
  expirationTime: null,
  keys: { p256dh: "p".repeat(65), auth: "a".repeat(24) },
};

const requestDetails = (): RequestDetails => ({
  method: "POST",
  endpoint: subscription.endpoint,
  headers: { TTL: "60", Authorization: "vapid" },
  body: Buffer.from("encrypted"),
});

describe("pinned Web Push transport", () => {
  test("connects to the validated IP while preserving host routing and TLS SNI", async () => {
    const prepared = await buildPinnedWebPushRequests(
      subscription,
      "payload",
      { TTL: 60 },
      {
        resolve: async () => [{ address: "1.1.1.1", family: 4 }],
        generateRequestDetails: requestDetails,
      },
    );

    expect(prepared.attempts[0]).toEqual(
      expect.objectContaining({
        hostname: "1.1.1.1",
        servername: "push.example.test",
        port: 443,
        path: "/subscriptions/one?token=two",
        method: "POST",
        rejectUnauthorized: true,
        headers: expect.objectContaining({ host: "push.example.test", Authorization: "vapid" }),
      }),
    );
    expect(prepared.endpoint).toBe(subscription.endpoint);
    expect(prepared.body).toEqual(Buffer.from("encrypted"));
  });

  test("keeps both address families in the bounded attempt list", async () => {
    const prepared = await buildPinnedWebPushRequests(
      subscription,
      "payload",
      { TTL: 60 },
      {
        resolve: async () => [
          { address: "2606:4700:4700::1", family: 6 },
          { address: "2606:4700:4700::2", family: 6 },
          { address: "2606:4700:4700::3", family: 6 },
          { address: "2606:4700:4700::4", family: 6 },
          { address: "1.1.1.1", family: 4 },
        ],
        generateRequestDetails: requestDetails,
      },
    );

    expect(prepared.attempts.map((attempt) => attempt.hostname)).toEqual([
      "2606:4700:4700::1",
      "1.1.1.1",
      "2606:4700:4700::2",
      "2606:4700:4700::3",
    ]);
  });

  test("tries another validated address after a connection failure", async () => {
    const attemptedHosts: string[] = [];
    const request = (options: RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest => {
      attemptedHosts.push(String(options.hostname));
      const outgoing = new EventEmitter() as ClientRequest;
      outgoing.write = () => true;
      outgoing.end = () => {
        if (attemptedHosts.length === 1) {
          queueMicrotask(() => outgoing.emit("error", new Error("connect failed")));
          return outgoing;
        }
        const response = new EventEmitter() as IncomingMessage;
        response.statusCode = 201;
        response.destroy = () => response;
        queueMicrotask(() => {
          callback(response);
          response.emit("end");
        });
        return outgoing;
      };
      outgoing.destroy = (error) => {
        if (error) queueMicrotask(() => outgoing.emit("error", error));
        return outgoing;
      };
      return outgoing;
    };

    await sendPinnedWebPush(
      subscription,
      "payload",
      { TTL: 60 },
      {
        resolve: async () => [
          { address: "1.1.1.1", family: 4 },
          { address: "8.8.8.8", family: 4 },
        ],
        generateRequestDetails: requestDetails,
        request,
      },
    );

    expect(attemptedHosts).toEqual(["1.1.1.1", "8.8.8.8"]);
  });
});

for (const mode of ["deadline", "caller"] as const)
  test(`Web Push ${mode} covers DNS without starting a request after a late answer`, async () => {
    const lookup = Promise.withResolvers<Array<{ address: string; family: 4 }>>();
    const caller = new AbortController();
    let sent = false;
    const pending = sendPinnedWebPush(
      subscription,
      "payload",
      { timeout: mode === "deadline" ? 10 : 15_000 },
      {
        signal: caller.signal,
        resolve: () => lookup.promise,
        generateRequestDetails: requestDetails,
        request: () => {
          sent = true;
          throw new Error("unexpected");
        },
      },
    );
    if (mode === "caller") caller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow(mode === "deadline" ? "timed out" : "cancelled");
    lookup.resolve([{ address: "1.1.1.1", family: 4 }]);
    await Bun.sleep(0);
    expect(sent).toBe(false);
  });

for (const mode of ["deadline", "caller"] as const)
  test(`Web Push ${mode} closes a slowly streaming provider response`, async () => {
    const provider = Promise.withResolvers<ServerResponse>();
    const firstChunk = Promise.withResolvers<void>();
    const secondChunk = Promise.withResolvers<void>();
    let chunks = 0;
    const fixture = await networkTransportFixture((_req, res) => {
      provider.resolve(res);
      res.writeHead(201);
      res.write("x");
    });
    const caller = new AbortController();
    jest.useFakeTimers();
    try {
      const pending = sendPinnedWebPush(
        subscription,
        "payload",
        { timeout: mode === "deadline" ? 80 : 15_000 },
        {
          signal: caller.signal,
          resolve: async () => [{ address: "1.1.1.1", family: 4 }],
          generateRequestDetails: requestDetails,
          request: (options, callback) =>
            fixture.request(options, (response) => {
              response.on("data", () => {
                if (++chunks === 1) firstChunk.resolve();
                else secondChunk.resolve();
              });
              callback(response);
            }),
        },
      );
      const rejected = expect(pending).rejects.toThrow(mode === "deadline" ? "timed out" : "cancelled");
      await firstChunk.promise;
      jest.advanceTimersByTime(40);
      (await provider.promise).write("y");
      await secondChunk.promise;
      // A fresh body chunk must not restart the original total deadline.
      if (mode === "caller") caller.abort(new Error("cancelled"));
      else jest.advanceTimersByTime(40);
      await rejected;
      expect(fixture.requests[0]!.destroyed).toBe(true);
      await fixture.disconnected();
      expect(fixture.responses[0]!.destroyed).toBe(true);
    } finally {
      caller.abort();
      jest.useRealTimers();
      await fixture.close();
    }
  });

test("Web Push address attempts retain one total deadline", async () => {
  const attempted: string[] = [];
  const fixture = await networkTransportFixture(() => {});
  try {
    await expect(
      sendPinnedWebPush(
        subscription,
        "payload",
        { timeout: 80 },
        {
          resolve: async () => [
            { address: "1.1.1.1", family: 4 },
            { address: "8.8.8.8", family: 4 },
            { address: "9.9.9.9", family: 4 },
          ],
          generateRequestDetails: requestDetails,
          request: (options, callback) => {
            attempted.push(String(options.hostname));
            const outgoing = fixture.request(options, callback);
            if (attempted.length === 1) queueMicrotask(() => outgoing.destroy(new Error("connect failed")));
            return outgoing;
          },
        },
      ),
    ).rejects.toThrow("timed out");
    expect(attempted).toEqual(["1.1.1.1", "8.8.8.8"]);
    expect(fixture.requests.every((request) => request.destroyed)).toBe(true);
    await fixture.disconnected();
  } finally {
    await fixture.close();
  }
});
