import { describe, expect, test } from "bun:test";
import { createWorkspaceRevisionController, type RevisionSnapshot } from "./workspace-revision-controller";

const initial: RevisionSnapshot = {
  revision: "one",
  resources: { "table:active": "a", "table:other": "b" },
  canWrite: true,
  canAdmin: true,
};
const tick = () => Bun.sleep(280);

describe("workspace structure reconciliation", () => {
  test("resync cannot reapply an expired cursor from an in-flight check", async () => {
    const pending: Array<(value: RevisionSnapshot) => void> = [];
    const cursors: Array<string | null> = [];
    const controller = createWorkspaceRevisionController({
      initial,
      activeKeys: [],
      load: () => new Promise((resolve) => pending.push(resolve)),
      apply: () => {},
      markApplied: (cursor) => cursors.push(cursor),
      onError: () => {},
    });
    try {
      controller.check("expired");
      await tick();
      controller.check(null);
      pending[0]!(initial);
      await Bun.sleep(0);
      expect(cursors).toEqual([]);
      pending[1]!(initial);
      await Bun.sleep(0);
      expect(cursors).toEqual([null]);
    } finally {
      controller.dispose();
    }
  });
  test("own fully reconciled resource clears only its own notice and cannot hide a concurrent edit", async () => {
    let snapshot = { ...initial, revision: "two", resources: { ...initial.resources, "table:active": "own" } };
    let applied: unknown;
    const controller = createWorkspaceRevisionController({
      initial,
      activeKeys: ["table:active"],
      load: async () => snapshot,
      apply: (state) => {
        applied = state;
      },
      markApplied: () => {},
      onError: () => {},
    });
    try {
      controller.check();
      await tick();
      expect(applied).toEqual({ changed: true, revoked: false });
      controller.acknowledge("table:active", "own");
      expect(applied).toEqual({ changed: false, revoked: false });
      snapshot = { ...snapshot, resources: { ...snapshot.resources, "table:active": "foreign" } };
      controller.check();
      await tick();
      controller.acknowledge("table:active", "own");
      expect(applied).toEqual({ changed: true, revoked: false });
    } finally {
      controller.dispose();
    }
  });
  test("bursts coalesce; unchanged reconnect is silent; changes outside the active resources stay silent", async () => {
    let snapshot = initial;
    let calls = 0;
    const applied: unknown[] = [];
    const cursors: Array<string | null> = [];
    const controller = createWorkspaceRevisionController({
      initial,
      activeKeys: ["table:active"],
      load: async () => {
        calls++;
        return snapshot;
      },
      apply: (state) => applied.push(state),
      markApplied: (cursor) => cursors.push(cursor),
      onError: () => {
        throw Error("unexpected");
      },
    });
    try {
      for (let i = 0; i < 20; i++) controller.check(`cursor-${i}`);
      await tick();
      expect(calls).toBe(1);
      expect(applied).toEqual([{ changed: false, revoked: false }]);
      expect(cursors).toEqual(["cursor-19"]);
      snapshot = { ...initial, revision: "two", resources: { ...initial.resources, "table:other": "c", "table:new": "d" } };
      controller.check();
      await tick();
      expect(applied.at(-1)).toEqual({ changed: false, revoked: false });
    } finally {
      controller.dispose();
    }
  });

  test("active structure and permission loss inform; deletion revokes the surface", async () => {
    let snapshot = initial;
    let applied: unknown;
    const controller = createWorkspaceRevisionController({
      initial,
      activeKeys: ["table:active"],
      load: async () => snapshot,
      apply: (state) => {
        applied = state;
      },
      markApplied: () => {},
      onError: () => {},
    });
    try {
      snapshot = { ...initial, resources: { ...initial.resources, "table:active": "changed" } };
      controller.check();
      await tick();
      expect(applied).toEqual({ changed: true, revoked: false });
      snapshot = { ...initial, canAdmin: false };
      controller.check();
      await tick();
      expect(applied).toEqual({ changed: true, revoked: false });
      snapshot = { ...initial, resources: { "table:other": "b" } };
      controller.check();
      await tick();
      expect(applied).toEqual({ changed: true, revoked: true });
    } finally {
      controller.dispose();
    }
  });

  test("only acknowledges a successful covering snapshot, with one follow-up during a request", async () => {
    const pending: Array<(value: RevisionSnapshot) => void> = [];
    const cursors: Array<string | null> = [];
    const controller = createWorkspaceRevisionController({
      initial,
      activeKeys: [],
      load: () => new Promise((resolve) => pending.push(resolve)),
      apply: () => {},
      markApplied: (cursor) => cursors.push(cursor),
      onError: () => {},
    });
    try {
      controller.check("first");
      await tick();
      controller.check("second");
      controller.check("third");
      expect(pending).toHaveLength(1);
      expect(cursors).toEqual([]);
      pending[0]!(initial);
      await Bun.sleep(0);
      expect(cursors).toEqual(["first"]);
      expect(pending).toHaveLength(2);
      pending[1]!(initial);
      await Bun.sleep(0);
      expect(cursors).toEqual(["first", "third"]);
    } finally {
      controller.dispose();
    }
  });

  test("failure does not acknowledge or loop; disposal ignores late success", async () => {
    let calls = 0;
    let errors = 0;
    const cursors: Array<string | null> = [];
    const controller = createWorkspaceRevisionController({
      initial,
      activeKeys: [],
      load: async () => {
        calls++;
        throw Error("offline");
      },
      apply: () => {},
      markApplied: (c) => cursors.push(c),
      onError: () => {
        errors++;
      },
    });
    controller.check("first");
    await tick();
    await tick();
    expect(calls).toBe(1);
    expect(errors).toBe(1);
    expect(cursors).toEqual([]);
    controller.dispose();
    controller.check();
    await tick();
    expect(calls).toBe(1);

    let resolve!: (snapshot: RevisionSnapshot) => void;
    let signal!: AbortSignal;
    const late = createWorkspaceRevisionController({
      initial,
      activeKeys: [],
      load: (s) => {
        signal = s;
        return new Promise((r) => {
          resolve = r;
        });
      },
      apply: () => {
        throw Error("must not apply");
      },
      markApplied: (c) => cursors.push(c),
      onError: () => {
        errors++;
      },
    });
    late.check("late");
    await tick();
    late.dispose();
    resolve(initial);
    await Bun.sleep(0);
    expect(signal.aborted).toBe(true);
    expect(cursors).toEqual([]);
    expect(errors).toBe(1);
  });
});
