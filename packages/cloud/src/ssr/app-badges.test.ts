import { expect, test } from "bun:test";
import { ApprovalCountsSchema } from "../contracts/approvals";
import { parseApprovalCounts } from "./app-badges";

// The badge reader only parses `response.json()`, so every body is JSON text.
const bodies: [string, string][] = [
  ["empty counts", '{"total":0,"apps":{}}'],
  ["app counts", '{"total":3,"apps":{"mail":2,"chat":1}}'],
  ["safe integer bound", `{"total":${Number.MAX_SAFE_INTEGER},"apps":{"mail":${Number.MAX_SAFE_INTEGER}}}`],
  ["negative zero", '{"total":-0,"apps":{}}'],
  ["constructor app", '{"total":1,"apps":{"constructor":1}}'],
  ["prototype key is ignored", '{"total":1,"apps":{"__proto__":0,"mail":1}}'],
  ["extra key", '{"total":0,"apps":{},"extra":true}'],
  ["missing total", '{"apps":{}}'],
  ["missing apps", '{"total":0}'],
  ["negative total", '{"total":-1,"apps":{}}'],
  ["fractional total", '{"total":1.5,"apps":{}}'],
  ["unsafe total", `{"total":${2 ** 53},"apps":{}}`],
  ["string total", '{"total":"1","apps":{}}'],
  ["null total", '{"total":null,"apps":{}}'],
  ["zero app", '{"total":0,"apps":{"mail":0}}'],
  ["negative app", '{"total":0,"apps":{"mail":-1}}'],
  ["fractional app", '{"total":1,"apps":{"mail":1.5}}'],
  ["unsafe app", `{"total":1,"apps":{"mail":${2 ** 53}}}`],
  ["string app", '{"total":1,"apps":{"mail":"1"}}'],
  ["nested app", '{"total":1,"apps":{"mail":{"count":1}}}'],
  ["array apps", '{"total":0,"apps":[]}'],
  ["null apps", '{"total":0,"apps":null}'],
  ["string apps", '{"total":0,"apps":"mail"}'],
  ["array", "[]"],
  ["null", "null"],
  ["string", '"counts"'],
  ["number", "1"],
];

test.each(bodies)("approval counts match the schema: %s", (_name, json) => {
  const expected = ApprovalCountsSchema.safeParse(JSON.parse(json));
  const actual = parseApprovalCounts(JSON.parse(json));
  expect(actual !== null).toBe(expected.success);
  if (expected.success) expect(actual).toStrictEqual(expected.data);
});
