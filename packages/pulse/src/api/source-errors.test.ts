import { expect, test } from "bun:test";
import { fail, ok } from "@k2b/cloud/server";
import { localizedSourceError, resolvePulseMessages } from "../messages";
import { scrapeTargetBlocked } from "../service/scrape-target";
import { localizedScrapeResult } from "./source-errors";

test("API transport localizes a blocked result into German and preserves its code and status", async () => {
  const result = await localizedScrapeResult(fail(scrapeTargetBlocked()), "de");
  expect(result).toMatchObject({
    ok: false,
    error: { code: "PULSE_SCRAPE_TARGET_BLOCKED", status: 400, message: resolvePulseMessages("de").t.scrapeTargetBlocked },
  });
  const success = ok("unchanged");
  expect(await localizedScrapeResult(success, "de")).toBe(success);
  const other = fail({ code: "OTHER", status: 400, message: "Other error" });
  expect(await localizedScrapeResult(other, "de")).toBe(other);
});

test("stored English refusal localizes for both source diagnostics and history, preserving other messages", () => {
  const en = resolvePulseMessages("en").t,
    de = resolvePulseMessages("de").t;
  expect(localizedSourceError(en.scrapeTargetBlocked, de)).toBe(de.scrapeTargetBlocked);
  expect(localizedSourceError("HTTP error", de)).toBe("HTTP error");
  expect(localizedSourceError(null, de)).toBeNull();
});
