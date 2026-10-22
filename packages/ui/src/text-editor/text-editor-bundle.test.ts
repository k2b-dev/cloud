import { expect, test } from "bun:test";
import { gzipSync } from "node:zlib";

test("editor engine with Yjs and awareness stays within the 140 KiB concept budget", async () => {
  // Same boundary as the approved spike: formatted/source engine, commands,
  // cell widgets, paste, Yjs and awareness. Solid controls are measured separately.
  const build = await Bun.build({
    entrypoints: [new URL("../../test/text-editor-engine.fixture.ts", import.meta.url).pathname],
    target: "browser",
    conditions: ["browser", "production"],
    format: "esm",
    minify: true,
  });
  if (!build.success) throw new AggregateError(build.logs, "Editor budget fixture did not build");
  const bytes = await Promise.all(build.outputs.map(async (output) => gzipSync(await output.arrayBuffer(), { level: 9 }).length));
  expect(bytes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(140 * 1024);
});
