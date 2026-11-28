import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertVerificationReport, localVerificationUrl, selectPhases, verificationSource } from "./verification";

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

test("verification checks load no other module, because tests, crash workers and diagnostics import them", () => {
  const source = readFileSync(resolve(import.meta.dir, "verification.ts"), "utf8");
  expect(new Bun.Transpiler({ loader: "ts" }).scanImports(source)).toEqual([]);
});

// A checkout names its source by git; a copy without `.git` (the test machine) by CLOUD_SOURCE_COMMIT/_DIRTY.
const COMMIT = "4f1c2a9e0b7d3c5a8e6f1b2d4c7a9e0f3b5d8c1a";
const git =
  (head: string | null, status = "") =>
  (command: string[]) =>
    command.includes("rev-parse") ? { exitCode: head ? 0 : 128, stdout: `${head ?? ""}\n` } : { exitCode: 0, stdout: status };

test("verification names its source by the checkout's commit and changes", () => {
  expect(verificationSource("/repo", {}, git(COMMIT))).toEqual({ commit: COMMIT, dirty: false });
  expect(verificationSource("/repo", {}, git(COMMIT, " M packages/grids/src/index.ts\n"))).toEqual({ commit: COMMIT, dirty: true });
  // a checkout wins over what the environment says
  expect(verificationSource("/repo", { CLOUD_SOURCE_COMMIT: "other", CLOUD_SOURCE_DIRTY: "1" }, git(COMMIT))).toEqual({
    commit: COMMIT,
    dirty: false,
  });
});

test("a copy without git names its source by the environment, and changed unless it says clean", () => {
  const copy = git(null);
  expect(verificationSource("/copy", { CLOUD_SOURCE_COMMIT: COMMIT, CLOUD_SOURCE_DIRTY: "0" }, copy)).toEqual({
    commit: COMMIT,
    dirty: false,
  });
  expect(verificationSource("/copy", { CLOUD_SOURCE_COMMIT: COMMIT, CLOUD_SOURCE_DIRTY: "false" }, copy)).toEqual({
    commit: COMMIT,
    dirty: false,
  });
  expect(verificationSource("/copy", { CLOUD_SOURCE_COMMIT: COMMIT, CLOUD_SOURCE_DIRTY: "1" }, copy)).toEqual({
    commit: COMMIT,
    dirty: true,
  });
  expect(verificationSource("/copy", { CLOUD_SOURCE_COMMIT: COMMIT }, copy)).toEqual({ commit: COMMIT, dirty: true });
  // neither git nor the environment: the run refuses, as a report must name its source
  expect(() => verificationSource("/copy", {}, copy)).toThrow("Cannot record verification commit");
  expect(() => verificationSource("/copy", { CLOUD_SOURCE_COMMIT: "  " }, copy)).toThrow("Cannot record verification commit");
});
