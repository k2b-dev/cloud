import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { assertPhaseCoverage, verificationPhases } from "./verification-phases";

test("every Grids test file runs in exactly one certification phase, behavior tests with browser conditions", async () => {
  const phases = await verificationPhases(resolve(import.meta.dir, "../../.."));
  const phase = (name: string) => phases.find((candidate) => candidate.name === name)!;
  const behavior = /\.behavior\.test\.tsx?$/;
  expect(phase("dom").files.length).toBeGreaterThan(0);
  expect(phase("dom").files.every((file) => behavior.test(file))).toBe(true);
  expect(phase("dom").flags).toContain("--conditions=browser");
  for (const other of phases.filter((candidate) => candidate.name !== "dom")) {
    expect(other.files.filter((file) => behavior.test(file))).toEqual([]);
  }
});

test("phase coverage rejects files that run in no phase or twice, empty phases and missing files", () => {
  const files = [import.meta.path, resolve(import.meta.dir, "verification-phases.ts")];
  expect(() => assertPhaseCoverage(files, [{ name: "a", files }])).not.toThrow();
  expect(() => assertPhaseCoverage(files, [{ name: "a", files: [files[0]!] }])).toThrow("verification-phases.ts runs in no phase");
  expect(() =>
    assertPhaseCoverage(files, [
      { name: "a", files },
      { name: "b", files: [files[1]!] },
    ]),
  ).toThrow("verification-phases.ts runs in phases a, b");
  expect(() =>
    assertPhaseCoverage(files, [
      { name: "a", files },
      { name: "b", files: [] },
    ]),
  ).toThrow("phase b has no test files");
  expect(() => assertPhaseCoverage(files, [{ name: "a", files: [...files, "/missing/gone.test.ts"] }])).toThrow(
    "/missing/gone.test.ts is listed in phase a but does not exist",
  );
});
