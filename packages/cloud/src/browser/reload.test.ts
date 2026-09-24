import { afterEach, beforeEach, expect, test } from "bun:test";
import { AUTOMATIC_RELOAD_WINDOW_MS, reloadOnce } from "./reload";

const originalWindow = globalThis.window;
const originalDateNow = Date.now;

let now: number;
let reloads: number;
let values: Map<string, string>;
let storageFails: boolean;

beforeEach(() => {
  now = 1_000_000;
  reloads = 0;
  values = new Map();
  storageFails = false;
  Date.now = () => now;
  const sessionStorage = {
    getItem: (key: string) => {
      if (storageFails) throw new Error("SecurityError");
      return values.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (storageFails) throw new Error("QuotaExceededError");
      values.set(key, value);
    },
  };
  (globalThis as unknown as { window: unknown }).window = { sessionStorage, location: { reload: () => (reloads += 1) } };
});

afterEach(() => {
  (globalThis as unknown as { window: unknown }).window = originalWindow;
  Date.now = originalDateNow;
});

test("reloads the first time and suppresses a repeat within the window", () => {
  expect(reloadOnce("spaces:live")).toBe(true);
  now += AUTOMATIC_RELOAD_WINDOW_MS - 1;
  expect(reloadOnce("spaces:live")).toBe(false);
  expect(reloads).toBe(1);
});

test("allows another reload once the window has passed", () => {
  expect(reloadOnce("spaces:live", { windowMs: 5_000 })).toBe(true);
  now += 5_000;
  expect(reloadOnce("spaces:live", { windowMs: 5_000 })).toBe(true);
  expect(reloads).toBe(2);
});

test("tracks keys independently", () => {
  expect(reloadOnce("spaces:live")).toBe(true);
  expect(reloadOnce("spaces:view")).toBe(true);
  expect(reloads).toBe(2);
});

test("does not reload automatically when sessionStorage is unavailable", () => {
  storageFails = true;
  expect(reloadOnce("spaces:live")).toBe(false);
  expect(reloads).toBe(0);
});
