/** Browser-safe names; server-side inspection below verifies the container signature. */
export const AI_AUDIO_EXTENSIONS = ["wav", "mp3", "mpga", "mpeg", "flac", "ogg", "oga", "opus", "m4a", "mp4", "webm"] as const;
// OpenAI file-transcription contract: 25 MB, expressed conservatively in decimal bytes.
export const AI_AUDIO_MAX_BYTES = 25_000_000;
export const AI_AUDIO_ACCEPT = AI_AUDIO_EXTENSIONS.map((extension) => `.${extension}`).join(",");
export type AiAudioFormat = { extension: string; mediaType: string };

/** Identifies containers, not codec validity; decoding errors remain provider errors. */
export const inspectAiAudio = (bytes: Uint8Array): AiAudioFormat => {
  if (!bytes.byteLength) throw new Error("The audio recording is empty.");
  if (bytes.byteLength > AI_AUDIO_MAX_BYTES) throw new Error("Audio transcription accepts files up to 25 MB.");
  const ascii = (offset: number, text: string) => [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
  if (bytes.length >= 12 && ascii(0, "RIFF") && ascii(8, "WAVE")) return { extension: "wav", mediaType: "audio/wav" };
  if (bytes.length >= 8 && ascii(0, "fLaC")) return { extension: "flac", mediaType: "audio/flac" };
  if (bytes.length >= 27 && ascii(0, "OggS") && bytes[4] === 0) return { extension: "ogg", mediaType: "audio/ogg" };
  if (bytes.length >= 12 && ascii(4, "ftyp")) return { extension: "m4a", mediaType: "audio/mp4" };
  if (bytes.length >= 8 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    const header = new TextDecoder().decode(bytes.subarray(0, 4096));
    if (header.includes("webm")) return { extension: "webm", mediaType: "audio/webm" };
  }
  if (bytes.length >= 10 && ascii(0, "ID3")) return { extension: "mp3", mediaType: "audio/mpeg" };
  if (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    (bytes[1]! & 0xe0) === 0xe0 &&
    (bytes[1]! & 0x06) !== 0 &&
    (bytes[1]! & 0x18) !== 0x08 &&
    (bytes[2]! & 0xf0) !== 0xf0 &&
    (bytes[2]! & 0x0c) !== 0x0c
  ) {
    return { extension: "mp3", mediaType: "audio/mpeg" };
  }
  throw new Error("Unsupported audio container. Use WAV, MP3, FLAC, OGG, M4A/MP4 or WebM.");
};
