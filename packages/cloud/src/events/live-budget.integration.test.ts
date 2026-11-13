import { expect, setSystemTime, spyOn } from "bun:test";
import { z } from "zod";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { testFor } from "../../../../scripts/fixtures/test-infra";
import { sql } from "../runtime/clients";
import type { IdentityAccessSubject } from "./app-access";
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
  let changed: (subject?: IdentityAccessSubject) => void = () => {};
  let authorized: (() => void) | undefined;
  const batches: string[][] = [];
  const engine = createLiveEngine({
    subscribeAccess: (callback) => {
      changed = callback;
      return () => {};
    },
    appId: "budget",
    topic: () => topic,
    channels: {
      item: {
        eventOnly: true,
        scope: z.object({}).strict(),
        keys: async () => ["one"],
        authorize: async (_key, viewers) => {
          await sql`SELECT 1`;
          batches.push(viewers.map((viewer) => viewer.id));
          authorized?.();
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
        async () => {
          await sql`SELECT 1`;
          return viewer;
        },
      );
      connection.message(JSON.stringify({ t: "sub", id: "one", channel: "item", scope: {}, after: await topic.head() }));
      await until(() => frames.some((frame) => frame.t === "ready"));
    });
    expect(setup).toHaveLength(2);
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
    const otherId = "22222222-2222-4222-8222-222222222222";
    if (viewer.actor.kind !== "user") throw new Error("Expected fixture user");
    const other: LiveViewer = {
      ...viewer,
      id: "other",
      actor: { kind: "user", user: { ...viewer.actor.user, id: otherId } },
      accessSubject: { type: "user", userId: otherId },
    };
    const ready = Promise.withResolvers<void>();
    const otherSetup = await meter.during(async () => {
      const connection = engine.open(
        {
          send: (frame) => {
            if (JSON.parse(frame).t === "ready") ready.resolve();
          },
          close: () => {},
          getBufferedAmount: () => 0,
        },
        other,
        async () => {
          await sql`SELECT 1`;
          return other;
        },
      );
      connection.message(JSON.stringify({ t: "sub", id: "other", channel: "item", scope: {} }));
      await ready.promise;
    });
    expect(otherSetup).toHaveLength(2);
    batches.length = 0;
    const unrelated = await meter.during(async () => {
      changed({ userId: "33333333-3333-4333-8333-333333333333" });
    });
    expect(unrelated).toHaveLength(0);
    const checked = Promise.withResolvers<void>();
    authorized = () => checked.resolve();
    const access = await meter.during(async () => {
      changed({ userId: "11111111-1111-4111-8111-111111111111" });
      await checked.promise;
    });
    expect(access).toHaveLength(2);
    expect(batches).toEqual([["budget"]]);
    console.log("SQL BUDGET shared live identity event", access.length);
  } finally {
    engine.stop();
    intervals.mockRestore();
    setSystemTime();
    await meter.close();
  }
});
