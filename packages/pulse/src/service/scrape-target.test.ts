import { afterEach, expect, test } from "bun:test";
import { NetworkTargetBlockedError } from "@k2b/cloud/services/network-security";
import { checkScrapeTarget } from "./scrape-target";

const previous = process.env.PULSE_SCRAPE_ALLOWED_TARGETS;
afterEach(() => {
  if (previous === undefined) delete process.env.PULSE_SCRAPE_ALLOWED_TARGETS;
  else process.env.PULSE_SCRAPE_ALLOWED_TARGETS = previous;
});

test("obsolete environment configuration never releases internal targets", async () => {
  process.env.PULSE_SCRAPE_ALLOWED_TARGETS = "valid.test,10.0.0.5/8,*.test";
  expect((await checkScrapeTarget("http://127.0.0.1/metrics")).ok).toBe(false);
});

test("source preflight rejects known policy refusals but permits unresolved or slow endpoints", async () => {
  delete process.env.PULSE_SCRAPE_ALLOWED_TARGETS;
  expect(await checkScrapeTarget("http://127.0.0.1/metrics")).toMatchObject({ ok: false, error: { code: "PULSE_SCRAPE_TARGET_BLOCKED" } });
  expect(
    await checkScrapeTarget("http://example.test", undefined, async () => {
      throw new NetworkTargetBlockedError("private");
    }),
  ).toMatchObject({ ok: false, error: { code: "PULSE_SCRAPE_TARGET_BLOCKED" } });
  expect(
    await checkScrapeTarget("http://example.test", undefined, async () => {
      throw new Error("DNS failed");
    }),
  ).toEqual({ ok: true, data: undefined });
  expect((await checkScrapeTarget("http://example.test", undefined, () => new Promise(() => {}), 10)).ok).toBe(true);
  process.env.PULSE_SCRAPE_ALLOWED_TARGETS = "127.0.0.0/8";
  expect((await checkScrapeTarget("http://127.0.0.1/metrics")).ok).toBe(false);
});
