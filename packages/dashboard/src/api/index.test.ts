import { describe, expect, test } from "bun:test";
import { WIDGET_SETTING_TEXT_MAX_LENGTH } from "@k2b/cloud/contracts";
import { repeatedKeysWithoutSettings, SettingsSchema } from "./index";

const entry = { id: "one", key: "weather/current", size: "small" as const };
const accepts = (board: unknown[]) => SettingsSchema.safeParse({ board }).success;

describe("dashboard save validation", () => {
  test("rejects duplicate ids and accepts different ids for one key", () => {
    expect(accepts([entry, { ...entry, key: "spaces/today" }])).toBeFalse();
    expect(accepts([entry, { ...entry, id: "two" }])).toBeTrue();
  });
  test("bounds settings and accepts a resource title snapshot", () => {
    expect(accepts([{ ...entry, settings: { a: true, b: true, c: true, d: true, e: true } }])).toBeFalse();
    expect(accepts([{ ...entry, settings: { note: "x".repeat(WIDGET_SETTING_TEXT_MAX_LENGTH + 1) } }])).toBeFalse();
    expect(accepts([{ ...entry, settings: { space: { type: "spaces.space", id: "a", title: "Home" } } }])).toBeTrue();
    for (const name of ["bad_name", "constructor", "toString", "a".repeat(33)]) {
      expect(accepts([{ ...entry, settings: { [name]: true } }])).toBeFalse();
    }
    expect(accepts([{ ...entry, settings: { space: { type: "spaces.space", id: "a", extra: true } } }])).toBeFalse();
  });
  test("restricts repeated keys only when a running widget declares no settings", () => {
    const board = [entry, { ...entry, id: "two" }];
    expect(repeatedKeysWithoutSettings(board, new Map([[entry.key, false]]))).toEqual([entry.key]);
    expect(repeatedKeysWithoutSettings(board, new Map([[entry.key, true]]))).toEqual([]);
    expect(repeatedKeysWithoutSettings(board, new Map())).toEqual([]);
  });
});
