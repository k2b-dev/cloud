import { expect, setSystemTime, spyOn } from "bun:test";
import { z } from "zod";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { testFor } from "../../../../scripts/fixtures/test-infra";
import { sql } from "../runtime/clients";
import type { LiveViewer } from "./live-engine";
import { createLiveEngine, createMemoryLiveTopic } from "./testing";

// The channel's single-statement decision makes the shared engine's delivery cost observable.
// AI's user channel itself has no SQL; applications with database-backed decisions must not pay it per delivery.
testFor("database")("SQL budget of live authorization across the two-second cache boundary", async () => {
  const meter = await meterSql();
  const topic = createMemoryLiveTopic();
  const frames: Array<{ t: string }> = [];
  let received: (() => void) | undefined;
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
  const until = async (check: () => boolean) => {
    if (check()) return;
    await new Promise<void>((resolve) => {
      received = () => {
        if (!check()) return;
        received = undefined;
        resolve();
      };
    });
  };
  const intervals = spyOn(globalThis, "setInterval");
  setSystemTime(fixed);
  try {
    const setup = await meter.during(async () => {
      const connection = engine.open(
        {
          send: (frame) => {
            frames.push(JSON.parse(frame));
            received?.();
          },
          close: () => {},
          getBufferedAmount: () => 0,
        },
        viewer,
        async () => viewer,
      );
      connection.message(JSON.stringify({ t: "sub", id: "one", channel: "item", scope: {}, after: await topic.head() }));
      await until(() => frames.some((frame) => frame.t === "ready"));
    });
    expect(setup).toHaveLength(1);
    expect(intervals.mock.calls.map(([, ms]) => ms)).toEqual([30_000]);
    for (const [index, elapsed] of [1, 2_001, 4_002, 60_001].entries()) {
      setSystemTime(fixed + elapsed);
      const statements = await meter.during(async () => {
        topic.publish({ v: 1, k: "one", d: { changed: index } });
        await until(() => frames.filter((frame) => frame.t === "event").length === index + 1);
      });
      console.log("SQL BUDGET shared live delivery", elapsed, statements.length);
      expect(statements).toHaveLength(0);
      const progress = await meter.during(async () => {
        for (const [tick] of intervals.mock.calls) tick();
      });
      expect(progress).toHaveLength(0);
      expect(frames.filter((frame) => frame.t === "progress")).toHaveLength(index + 1);
    }
  } finally {
    engine.stop();
    intervals.mockRestore();
    setSystemTime();
    await meter.close();
  }
});
