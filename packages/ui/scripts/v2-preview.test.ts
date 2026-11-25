import { expect, test } from "bun:test";
import { resolve } from "node:path";

// `v2-preview --text` outlines a screen from its server markup in happy-dom, without a browser. A chart's SVG brings a
// <style>, after which happy-dom dropped the rest of the markup: the outline ended at the first Canvas with a chart.
test("--text outlines what follows a chart in a Canvas", async () => {
  const run = Bun.spawn(
    ["bun", resolve(import.meta.dir, "v2-preview.ts"), resolve(import.meta.dir, "../test/v2-preview-chart.fixture.tsx"), "--text"],
    {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    },
  );
  const [out, code] = [await new Response(run.stdout).text(), await run.exited];
  expect(out).toContain('Canvas "Präfixverteilung"');
  expect(out).toContain('Section "Nach dem Bild"');
  expect(out).toContain('"Steht im Umriss."');
  expect(code).toBe(0);
}, 120_000);
