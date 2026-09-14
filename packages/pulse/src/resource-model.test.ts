import { describe, expect, test } from "bun:test";
import { explicitPulseResource } from "./resource-model";
import { PULSE_RESOURCE_KEY_MAX_LENGTH } from "./telemetry-contract";

describe("Pulse resource identity", () => {
  test("uses explicit type and id while keeping labels out of identity", () => {
    expect(explicitPulseResource({ type: "host", id: "alpha", label: "Alpha" })).toEqual({
      key: "host:alpha",
      type: "host",
      id: "alpha",
      label: "Alpha",
    });
    expect(explicitPulseResource({ type: "host", id: "alpha", label: "Renamed" })?.key).toBe("host:alpha");
    expect(explicitPulseResource(undefined)).toBeNull();
    expect(explicitPulseResource(null)).toBeNull();
  });
  test("rejects ambiguous types and distinguishes equal ids of different types", () => {
    expect(explicitPulseResource({ type: "a:b", id: "c" })).toBeNull();
    expect(explicitPulseResource({ type: "a", id: "b:c" })?.key).toBe("a:b:c");
    expect(explicitPulseResource({ type: "host", id: "alpha" })?.key).not.toBe(
      explicitPulseResource({ type: "service", id: "alpha" })?.key,
    );
  });
  test("keeps resource keys within the Cloud reference budget", () => {
    const type = "service";
    const id = "a".repeat(PULSE_RESOURCE_KEY_MAX_LENGTH - type.length - 1);
    expect(explicitPulseResource({ type, id })?.key).toHaveLength(PULSE_RESOURCE_KEY_MAX_LENGTH);
    expect(explicitPulseResource({ type, id: `${id}a` })).toBeNull();
  });
});
