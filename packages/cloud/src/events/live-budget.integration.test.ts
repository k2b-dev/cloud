import { expect, setSystemTime } from "bun:test";
import { z } from "zod";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { testFor } from "../../../../scripts/fixtures/test-infra";
import { sql } from "../runtime/clients";
import type { LiveViewer } from "./live-engine";
import { createLiveEngine, createMemoryLiveTopic, LIVE_LIMITS } from "./testing";

// The channel's single-statement decision makes the shared engine's cache cost observable.
// AI's user channel itself has no SQL; applications with database-backed decisions pay this cost.
testFor("database")("SQL budget of live authorization across the two-second cache boundary", async () => {
  const meter = await meterSql();
  const topic = createMemoryLiveTopic();
  const frames: Array<{ t: string }> = [];
  const ready = Promise.withResolvers<void>();
  const events = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
  const fixed = new Date("2026-11-13T00:00:00Z").getTime();
  const viewer: LiveViewer = {
    id: "budget",
    actor: {
      kind: "user",
      user: {
        id: "11111111-1111-4111-8111-111111111111",
        uid: "budget",
        roles: ["user"],
        provider: "local",
        profile: "user",
        givenname: "Budget",
        sn: "Test",
        displayName: "Budget Test",
        mail: null,
        avatarHash: null,
        ipa: null,
        accountExpires: null,
        lastLoginLocal: null,
        memberofGroup: [],
        memberofGroupIds: [],
        manages: [],
        managesGroupIds: [],
      },
    },
    accessSubject: { type: "user", userId: "11111111-1111-4111-8111-111111111111" },
    scopes: [],
  };
  const engine = createLiveEngine({
    appId: "budget",
    topic: () => topic,
    channels: {
      item: {
        scope: z.object({}).strict(),
        keys: async () => ["one"],
        authorize: async (_key, viewers) => {
          await sql`SELECT 1`;
          return new Set(viewers.map((item) => item.id));
        },
      },
    },
  });
  setSystemTime(fixed);
  try {
    const setup = await meter.during(async () => {
      const connection = engine.open(
        {
          send: (frame) => {
            const received: (typeof frames)[number] = JSON.parse(frame);
            frames.push(received);
            if (received.t === "ready") ready.resolve();
            if (received.t === "event") events[frames.filter((item) => item.t === "event").length - 1]?.resolve();
          },
          close: () => {},
          getBufferedAmount: () => 0,
        },
        viewer,
        async () => viewer,
      );
      connection.message(JSON.stringify({ t: "sub", id: "one", channel: "item", scope: {}, after: await topic.head() }));
      await ready.promise;
      expect(frames.some((frame) => frame.t === "ready")).toBe(true);
    });
    expect(setup).toHaveLength(1);
    for (const [index, elapsed] of [1, LIVE_LIMITS.cacheMs + 1, 2 * LIVE_LIMITS.cacheMs + 2].entries()) {
      setSystemTime(fixed + elapsed);
      const statements = await meter.during(async () => {
        topic.publish({ v: 1, k: "one", d: { changed: index } });
        await events[index]!.promise;
        expect(frames.filter((frame) => frame.t === "event")).toHaveLength(index + 1);
      });
      console.log("SQL BUDGET shared live delivery", elapsed, statements.length);
      expect(statements).toHaveLength(index === 0 ? 0 : 1);
    }
  } finally {
    engine.stop();
    setSystemTime();
    await meter.close();
  }
});
