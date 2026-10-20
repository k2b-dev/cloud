import { describe, expect, test } from "bun:test";
import { type PulsePublicResourceTable, projectPublicRelations } from "./public-resources";

const BASE_UUID = "00000000-0000-4000-8000-000000000001";
const SOURCE_UUID = "00000000-0000-4000-8000-000000000003";
const DELETED_SOURCE_UUID = "00000000-0000-4000-8000-000000000004";
const PAYLOAD_UUID = "00000000-0000-4000-8000-000000000005";

const lookup = async (table: PulsePublicResourceTable, values: readonly (string | null | undefined)[]) => {
  const known = new Map<string, string>([
    [BASE_UUID, "Base01"],
    [SOURCE_UUID, "Src001"],
  ]);
  return new Map(values.flatMap((value) => (value && known.has(value) ? [[value, known.get(value)!] as const] : [])));
};

describe("Pulse public resource IDs", () => {
  test("projects known relations without traversing opaque telemetry data", async () => {
    const points = Array.from({ length: 10_000 }, (_, index) => ({
      bucket: `2026-08-12T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
      value: index,
      group: { sourceId: PAYLOAD_UUID },
    }));
    const payload = { sourceId: PAYLOAD_UUID, nested: { baseId: PAYLOAD_UUID } };
    const input = {
      baseId: BASE_UUID,
      sourceId: SOURCE_UUID,
      sourceIds: [SOURCE_UUID, DELETED_SOURCE_UUID],
      attributes: { sourceId: PAYLOAD_UUID },
      dimensions: { baseId: PAYLOAD_UUID },
      payload,
      points,
    };

    const result = await projectPublicRelations(input, lookup);

    expect(result.baseId).toBe("Base01");
    expect(result.sourceId).toBe("Src001");
    expect(result.sourceIds).toEqual(["Src001"]);
    expect(result.payload).toBe(payload);
    expect(result.attributes).toBe(input.attributes);
    expect(result.dimensions).toBe(input.dimensions);
    expect(result.points).toBe(points);
    expect(result.payload.sourceId).toBe(PAYLOAD_UUID);
  });
});
