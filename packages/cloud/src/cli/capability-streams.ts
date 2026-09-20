import { createWriteStream } from "node:fs";
import { link, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { exactStream } from "../capabilities/stream-body";
import type { CapabilityStream } from "../contracts/capabilities";

/** Publish only a complete download; never overwrite an existing local file. */
export async function saveCapabilityStream(response: Response, stream: CapabilityStream, output: string, signal: AbortSignal) {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Stream read failed (HTTP ${response.status}).`);
  }
  const path = resolve(output);
  const temporary = await mkdtemp(join(dirname(path), ".cloud-stream-"));
  try {
    const part = join(temporary, "content");
    await pipeline(exactStream(response.body, stream.size), createWriteStream(part, { flags: "wx", mode: 0o600 }), { signal });
    signal.throwIfAborted();
    await link(part, path);
    return { path, bytes: stream.size };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
