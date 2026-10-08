import { expect, test } from "bun:test";
import { headers, report, status, structure } from "./fixtures";
import { dsnParts, parseDsn } from "./parser";

test("RFC 3464 report selects status and only returned message headers", () => {
  expect(dsnParts(structure)).toEqual({ status: "2", headers: "3.HEADER" });
  expect(parseDsn(status, headers)).toEqual(report);
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
    expect(parseDsn(status.replaceAll("failed", action), headers)).toBeNull();
});
test("ordinary bounce text and non-delivery reports are ignored", () => {
  expect(dsnParts({ type: "text/plain" })).toBeNull();
  expect(dsnParts({ ...structure, parameters: { "report-type": "disposition-notification" } })).toBeNull();
  expect(dsnParts({ ...structure, childNodes: [] })).toBeNull();
});
test("non-UUID message IDs cannot match sent mail", () => {
  expect(parseDsn(status, "Message-ID: <abc@example.org>\r\n")).toBeNull();
});
test("folding and field case work for multiple failed recipients", () => {
  expect(parseDsn(status, headers.replace("Message-ID:", "mEsSaGe-Id:\r\n "))).toEqual(report);
});
test("only recipient blocks count, with bounded diagnostics and valid addresses", () => {
  const long =
    "Reporting-MTA: dns; mx.example.org\r\n\r\nFinal-Recipient: rfc822; other@example.org\r\nAction: failed\r\nStatus: 5.1.1\r\nDiagnostic-Code: smtp; " +
    "x".repeat(2000);
  expect(parseDsn(long, headers)?.failures[0]?.reason).toHaveLength(1000);
  expect(parseDsn(status.replaceAll("rfc822;", "x400;"), headers)).toBeNull();
});

test("failed delivery after a temporary SMTP error still bounces", () => {
  expect(parseDsn(status.replace("5.1.1", "4.4.7"), headers)?.failures[0]?.reason).toBe("4.4.7 smtp; 550 Unknown recipient");
});

test.each(["first~last@example.org", "a#b@example.org", "user@localhost"])("extracts send-schema recipient %s", (recipient) => {
  const parsed = parseDsn(status.replaceAll("first@example.org", recipient), headers);
  expect(parsed?.failures[0]?.recipient).toBe(recipient);
});
test("extracts angle brackets and Original-Recipient for matching", () => {
  const parsed = parseDsn(
    status.replace("rfc822; first@example.org", "rfc822; <first@example.org>\r\nOriginal-Recipient: rfc822; <original@example.org>"),
    headers,
  );
  expect(parsed?.failures[0]).toMatchObject({ recipient: "first@example.org", originalRecipient: "original@example.org" });
});
test("reported Message-ID survives sender domain changes and UUID case", () => {
  const reported = headers
    .replace(report.messageId, report.messageId.replace("example.org", "Old.Example"))
    .replace("89ab-4def", "89AB-4DEF");
  expect(parseDsn(status, reported)).toMatchObject({
    id: "01234567-89ab-4def-8012-3456789abcde",
    messageId: "<01234567-89AB-4DEF-8012-3456789abcde@Old.Example>",
  });
});

test("extracts Original-Recipient when Final-Recipient is absent", () => {
  const parsed = parseDsn(
    status.replaceAll("Final-Recipient:", "Original-Recipient:").replaceAll("final-recipient:", "original-recipient:"),
    headers,
  );
  expect(parsed?.failures[0]).toMatchObject({ recipient: "first@example.org", originalRecipient: "first@example.org" });
});
