import { expect, test } from "bun:test";
import { assertVerificationReport, localVerificationUrl } from "./verification";

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
