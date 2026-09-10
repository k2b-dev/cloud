import { expect, test } from "bun:test";
import { AI_AUDIO_MAX_BYTES, inspectAiAudio } from "./audio-format";

test("recognizes containers from bytes independently of filenames and MIME", () => {
  for (const [prefix, length, extension] of [
    ["RIFFxxxxWAVE", 44, "wav"],
    ["fLaC", 8, "flac"],
    ["OggS", 27, "ogg"],
    ["xxxxftypM4A ", 12, "m4a"],
    ["ID3", 10, "mp3"],
  ] as const) {
    const bytes = new Uint8Array(length);
    bytes.set(new TextEncoder().encode(prefix));
    expect(inspectAiAudio(bytes).extension).toBe(extension);
  }
  expect(inspectAiAudio(new Uint8Array([0xff, 0xfb, 0x90, 0x00])).extension).toBe("mp3");
  const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new TextEncoder().encode("webm")]);
  expect(inspectAiAudio(webm).extension).toBe("webm");
});

test("rejects empty, unsupported, truncated and oversized input before provider contact", () => {
  for (const bytes of [
    new Uint8Array(),
    new TextEncoder().encode("not audio"),
    new TextEncoder().encode("RIFF"),
    new Uint8Array([0xff, 0xff, 0xff, 0xff]),
    new Uint8Array(AI_AUDIO_MAX_BYTES + 1),
  ]) {
    expect(() => inspectAiAudio(bytes)).toThrow();
  }
});
