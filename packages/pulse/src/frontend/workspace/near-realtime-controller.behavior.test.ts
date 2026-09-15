import { expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { PulseDashboard } from "../../contracts";
import { installNearRealtimeController } from "./near-realtime-controller";

const browserTest = isServer ? test.skip : test;
browserTest(
  "dashboard replacement keeps an in-flight refresh and schedules only after completion",
  async () => {
    const dom = createDomTestHarness();
    const dashboard: PulseDashboard = {
      id: "dashboard-1",
      baseId: "base-1",
      name: "Ops",
      config: { dsl: "", layout: null, refreshIntervalSeconds: 1 },
      publicEnabled: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let refreshes = 0;
    let replace!: (value: PulseDashboard) => void;
    const dispose = createRoot((dispose) => {
      const [selectedDashboard, setDashboard] = createSignal(dashboard);
      replace = setDashboard;
      installNearRealtimeController({
        selectedBaseId: () => "base-1",
        activeView: () => "dashboard",
        selectedDashboard,
        refreshDashboard: () => {
          refreshes++;
          return pending;
        },
        refreshActivity: async () => {},
        refreshResources: async () => {},
        refreshSources: async () => {},
      });
      return dispose;
    });
    try {
      await Bun.sleep(1600);
      expect(refreshes).toBe(1);
      replace(structuredClone(dashboard));
      replace({ ...dashboard, name: "Renamed" });
      await Bun.sleep(1600);
      expect(refreshes).toBe(1);
      finish();
      await Bun.sleep(1600);
      expect(refreshes).toBe(2);
      replace({ ...dashboard, config: { ...dashboard.config, refreshIntervalSeconds: null } });
      await Bun.sleep(1600);
      expect(refreshes).toBe(2);
    } finally {
      dispose();
      finish();
      dom.cleanup();
    }
  },
  15_000,
);
