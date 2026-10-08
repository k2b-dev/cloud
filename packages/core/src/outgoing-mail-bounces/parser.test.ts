import { expect, test } from "bun:test";
import { headers, report, status, structure } from "./fixtures";
import { dsnParts, parseDsn } from "./parser";

test("RFC 3464 report selects status and only returned message headers", () => {
  expect(dsnParts(structure)).toEqual({ status: "2", headers: "3.HEADER" });
  expect(parseDsn(status, headers, "sender@example.org")).toEqual(report);
});
test("headers-only reports use text/rfc822-headers", () => {
  expect(
    dsnParts({
      ...structure,
      childNodes: [structure.childNodes[0]!, structure.childNodes[1]!, { part: "3", type: "text/rfc822-headers" }],
    }),
  ).toEqual({ status: "2", headers: "3" });
});
test("delayed, delivered, relayed and expanded recipients do not bounce", () => {
  for (const action of ["delayed", "delivered", "relayed", "expanded"])
    expect(parseDsn(status.replaceAll("failed", action), headers, "sender@example.org")).toBeNull();
});
test("ordinary bounce text and non-delivery reports are ignored", () => {
  expect(dsnParts({ type: "text/plain" })).toBeNull();
  expect(dsnParts({ ...structure, parameters: { "report-type": "disposition-notification" } })).toBeNull();
  expect(dsnParts({ ...structure, childNodes: [] })).toBeNull();
});
test("foreign and non-UUID message IDs cannot match sent mail", () => {
  expect(parseDsn(status, headers, "sender@foreign.org")).toBeNull();
  expect(parseDsn(status, "Message-ID: <abc@example.org>\r\n", "sender@example.org")).toBeNull();
});
test("folding and field case work for multiple failed recipients", () => {
  expect(
    parseDsn(status, headers.replace("Message-ID:", "mEsSaGe-Id:\r\n ").replace("example.org", "EXAMPLE.ORG"), "sender@example.org"),
  ).toEqual(report);
});
test("only recipient blocks count, with bounded diagnostics and valid addresses", () => {
  const long =
    "Reporting-MTA: dns; mx.example.org\r\n\r\nFinal-Recipient: rfc822; other@example.org\r\nAction: failed\r\nStatus: 5.1.1\r\nDiagnostic-Code: smtp; " +
    "x".repeat(2000);
  expect(parseDsn(long, headers, "sender@example.org")?.failures[0]?.reason).toHaveLength(1000);
  expect(parseDsn(status.replaceAll("rfc822;", "x400;"), headers, "sender@example.org")).toBeNull();
});

test("failed delivery after a temporary SMTP error still bounces", () => {
  expect(parseDsn(status.replace("5.1.1", "4.4.7"), headers, "sender@example.org")?.failures[0]?.reason).toBe(
    "4.4.7 smtp; 550 Unknown recipient",
  );
});
