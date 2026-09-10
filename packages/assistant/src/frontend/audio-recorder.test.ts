import { expect, test } from "bun:test";
import { encodeMonoWav } from "./audio-recorder";

test("encodes a complete mono PCM WAV with correct timing and clamped samples", async () => {
  const blob = encodeMonoWav([new Float32Array([-2, -0.5]), new Float32Array([0, 0.5, 2])], 48_000);
  expect(blob.type).toBe("audio/wav");
  const bytes = await blob.arrayBuffer();
  const view = new DataView(bytes);
  expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
  expect(view.getUint32(4, true)).toBe(bytes.byteLength - 8);
  expect(view.getUint32(24, true)).toBe(48_000);
  expect(view.getUint32(40, true)).toBe(10);
  expect([0, 1, 2, 3, 4].map((index) => view.getInt16(44 + index * 2, true))).toEqual([-32768, -16384, 0, 16384, 32767]);
});
test("does not upload an empty or oversized recording", () => {
  expect(() => encodeMonoWav([], 48_000)).toThrow();
  expect(() => encodeMonoWav([new Float32Array(12_500_000)], 48_000)).toThrow();
});
