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
  test("a resync discards the check that was already running", async () => {
    const pending: Array<(value: RevisionSnapshot) => void> = [];
    const applied: unknown[] = [];
    const controller = createWorkspaceRevisionController({
      initial,
      activeKeys: ["table:active"],
      load: () => new Promise((resolve) => pending.push(resolve)),
      apply: (state) => applied.push(state),
      onError: () => {},
    });
    try {
      controller.check();
      await tick();
      controller.check(true);
      pending[0]!({ ...initial, resources: { ...initial.resources, "table:active": "stale" } });
      await Bun.sleep(0);
      expect(applied).toEqual([]);
      pending[1]!(initial);
      await Bun.sleep(0);
      expect(applied).toEqual([{ changed: false, revoked: false }]);
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
    const controller = createWorkspaceRevisionController({
      initial,
      activeKeys: ["table:active"],
      load: async () => {
        calls++;
        return snapshot;
      },
      apply: (state) => applied.push(state),
      onError: () => {
        throw Error("unexpected");
      },
    });
    try {
      for (let i = 0; i < 20; i++) controller.check();
      await tick();
      expect(calls).toBe(1);
      expect(applied).toEqual([{ changed: false, revoked: false }]);
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

  test("changes during a request lead to one follow-up check", async () => {
    const pending: Array<(value: RevisionSnapshot) => void> = [];
    let applied = 0;
    const controller = createWorkspaceRevisionController({
      initial,
      activeKeys: [],
      load: () => new Promise((resolve) => pending.push(resolve)),
      apply: () => {
        applied++;
      },
      onError: () => {},
    });
    try {
      controller.check();
      await tick();
      controller.check();
      controller.check();
      expect(pending).toHaveLength(1);
      pending[0]!(initial);
      await Bun.sleep(0);
      expect(applied).toBe(1);
      expect(pending).toHaveLength(2);
      pending[1]!(initial);
      await Bun.sleep(0);
      expect(applied).toBe(2);
      expect(pending).toHaveLength(2);
    } finally {
      controller.dispose();
    }
  });

  test("failure does not loop; disposal ignores late success", async () => {
    let calls = 0;
    let errors = 0;
    const controller = createWorkspaceRevisionController({
      initial,
      activeKeys: [],
      load: async () => {
        calls++;
        throw Error("offline");
      },
      apply: () => {},
      onError: () => {
        errors++;
      },
    });
    controller.check();
    await tick();
    await tick();
    expect(calls).toBe(1);
    expect(errors).toBe(1);
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
      onError: () => {
        errors++;
      },
    });
    late.check();
    await tick();
    late.dispose();
    resolve(initial);
    await Bun.sleep(0);
    expect(signal.aborted).toBe(true);
    expect(errors).toBe(1);
  });
});
