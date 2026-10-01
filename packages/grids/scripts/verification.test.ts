import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { assertPhaseCoverage, assertVerificationReport, localVerificationUrl, selectPhases, verificationPhases } from "./verification";

test("verification rejects empty, skipped and failed reports", () => {
  for (const xml of [
    "",
    "<testsuites/>",
    "<testsuite><testcase><skipped/></testcase></testsuite>",
    "<testsuite><testcase><failure/></testcase></testsuite>",
    '<testsuite errors="1"><testcase/></testsuite>',
    '<testsuite skipped="3"><testcase/></testsuite>',
  ]) {
    expect(() => assertVerificationReport(xml, "fixture")).toThrow();
  }
  expect(() =>
    assertVerificationReport('<testsuite failures="0" skipped="0"><testcase name="real assertion"/></testsuite>', "fixture"),
  ).not.toThrow();
});

test("verification rejects remote, malformed and wrong-protocol infrastructure without leaking credentials", () => {
  for (const service of ["PostgreSQL", "NATS", "Gotenberg"] as const) {
    for (const value of [undefined, "invalid", "https://user:private-password@example.com", "file://localhost/tmp/data"]) {
      expect(() => localVerificationUrl(service, value)).toThrow(`Grids verification requires local ${service}`);
    }
  }
  expect(localVerificationUrl("PostgreSQL", "postgres://user:password@localhost/test").hostname).toBe("localhost");
  expect(localVerificationUrl("NATS", "nats://127.0.0.1:4222").port).toBe("4222");
  expect(localVerificationUrl("Gotenberg", "http://gotenberg:3000").hostname).toBe("gotenberg");
});

test("verification selects phases by name and by shard", () => {
  const phases = ["a", "b", "c", "d", "e"].map((name) => ({ name }));
  expect(selectPhases(phases, {}).map((phase) => phase.name)).toEqual(["a", "b", "c", "d", "e"]);
  expect(selectPhases(phases, { phase: "c" }).map((phase) => phase.name)).toEqual(["c"]);
  expect(selectPhases(phases, { shard: "1/2" }).map((phase) => phase.name)).toEqual(["a", "c", "e"]);
  expect(selectPhases(phases, { shard: "2/2" }).map((phase) => phase.name)).toEqual(["b", "d"]);
  expect(selectPhases(phases, { shard: "3/3", phase: "c" }).map((phase) => phase.name)).toEqual(["c"]);
  expect(() => selectPhases(phases, { phase: "z" })).toThrow('Unknown phase "z"');
  for (const shard of ["0/2", "3/2", "a/b", "2"]) expect(() => selectPhases(phases, { shard })).toThrow("Invalid shard");
});

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
  const files = [import.meta.path, resolve(import.meta.dir, "verification.ts")];
  expect(() => assertPhaseCoverage(files, [{ name: "a", files }])).not.toThrow();
  expect(() => assertPhaseCoverage(files, [{ name: "a", files: [files[0]!] }])).toThrow("verification.ts runs in no phase");
  expect(() =>
    assertPhaseCoverage(files, [
      { name: "a", files },
      { name: "b", files: [files[1]!] },
    ]),
  ).toThrow("verification.ts runs in phases a, b");
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
