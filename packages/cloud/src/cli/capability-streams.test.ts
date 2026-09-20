import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCapabilityStream } from "./capability-streams";

test("stream CLI publishes complete bytes only and never replaces a local file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stream-cli-test-"));
  const ref = {
    id: "one",
    direction: "read" as const,
    mediaType: "text/csv",
    size: 3,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  try {
    const output = join(dir, "data.csv");
    const signal = new AbortController().signal;
    await expect(saveCapabilityStream(new Response("ab"), ref, output, signal)).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
    await saveCapabilityStream(new Response("abc"), ref, output, signal);
    expect(await readFile(output, "utf8")).toBe("abc");
    await expect(saveCapabilityStream(new Response("xyz"), ref, output, signal)).rejects.toThrow();
    expect(await readFile(output, "utf8")).toBe("abc");
    expect(await readdir(dir)).toEqual(["data.csv"]);
  } finally {
    await rm(dir, { recursive: true });
  }
});
