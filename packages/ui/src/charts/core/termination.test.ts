import { expect, test } from "bun:test";
import { resolve } from "node:path";

// A tick loop that stops advancing blocks its thread, so the drawings run in a child process with a deadline.
test("every axis kind finishes drawing values beyond the float spacing or the tick budget", async () => {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "termination.test-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
  const deadline = setTimeout(() => child.kill(), 20_000);
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(deadline);
  const lines = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { name?: string; svg?: number; nan?: boolean; ticks?: number[]; done?: number });
  const drawn = lines.filter((line) => line.name !== undefined);
  expect(exit, `${stderr}\nfinished: ${drawn.map((line) => line.name).join(", ")}`).toBe(0);
  expect(lines.at(-1)?.done).toBe(drawn.length);
  for (const line of drawn) if (line.svg !== undefined) expect({ name: line.name, nan: line.nan }).toEqual({ name: line.name, nan: false });
  const ticks = Object.fromEntries(drawn.flatMap((line) => (line.ticks ? [[line.name, line.ticks]] : [])));
  expect(ticks).toEqual({
    "nice ticks, step below the float spacing": [1e17],
    "nice ticks, step past the budget": [0, 1],
    "nice ticks, negative step": [0, 10],
    "time ticks, instants past the Date range": [],
    // The first wall is a tick; a step that does not reach the next minute ends the loop instead of repeating it.
    "time ticks, a step below the float spacing": [Date.UTC(2026, 0, 1)],
    "time ticks, a step that repeats one minute": [Date.UTC(2026, 0, 1)],
    "time ticks, a zero year step": [Date.UTC(2026, 0, 1)],
    "time ticks, a negative step": [Date.UTC(2026, 0, 1)],
  });
}, 30_000);
