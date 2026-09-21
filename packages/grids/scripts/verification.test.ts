import { expect, test } from "bun:test";
import { assertVerificationReport, localVerificationUrl, selectPhases } from "./verification";

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
