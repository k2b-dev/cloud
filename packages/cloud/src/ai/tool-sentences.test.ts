import { expect, test } from "bun:test";
import { capabilityReviewSentence, capabilitySentenceText } from "../_internal/capability-sentences";
import { assertCapabilityReview } from "../capabilities/testing";
import { cloudToolReview } from "./tool-sentences";

const inputs = {
  code_run: { code: "export default () => 1" },
  code_action: { id: "Ab3dEf", action: "send", publishedVersion: 1 },
  web_extract: { url: "https://example.com/page?private=value" },
  fetch_file: { url: "https://example.com/report.pdf" },
  write_file: { path: "/reports/report.txt", content: "Report" },
};

test("every Cloud tool builds the public per-call review shape in German and English", () => {
  for (const locale of ["de", "en"]) {
    for (const [name, args] of Object.entries(inputs)) {
      const review = cloudToolReview(name, args, locale);
      expect(review).not.toBeNull();
      assertCapabilityReview(review);
      expect(review?.locale).toBe(locale);
      expect(
        review && capabilitySentenceText(review.sentence.action, review.slots, { locale: review.locale, timeZone: "UTC" }),
      ).toBeTruthy();
      for (const form of ["running", "done", "confirm", "decline", "notRun"] as const)
        expect(review && capabilityReviewSentence(review, form, { timeZone: "UTC" })).toBeTruthy();
    }
  }
});

test("web tools keep the whole address in the preview and only the host in a place slot", () => {
  const url = `https://example.com/${"x".repeat(1970)}`;
  const review = cloudToolReview("web_extract", { url }, "de-CH");
  expect(review?.locale).toBe("de");
  expect(review?.slots).toEqual({ site: { kind: "place", title: "example.com" } });
  expect(review?.preview).toEqual({ kind: "fields", rows: [{ label: "Adresse", value: url }] });
  expect(review && capabilityReviewSentence(review, "question", { timeZone: "UTC" })).toBe("Seite auf „example.com“ lesen?");
  expect(cloudToolReview("fetch_file", inputs.fetch_file, "fr")?.locale).toBe("en");
});

test("historical malformed inputs do not throw and long file names respect slot bounds", () => {
  for (const name of Object.keys(inputs)) {
    for (const args of [null, [], 7]) expect(cloudToolReview(name, args, "en")).toBeNull();
  }
  for (const name of ["web_extract", "fetch_file", "write_file", "code_action"]) {
    expect(cloudToolReview(name, {}, "en")).toBeNull();
  }
  expect(cloudToolReview("web_extract", { url: "bad URL" }, "en")).toBeNull();
  // An address longer than the address row is cut in the middle, so the question still asks.
  const long = cloudToolReview("web_extract", { url: `https://example.com/${"x".repeat(2000)}` }, "en");
  expect(long?.preview?.kind === "fields" && long.preview.rows[0]?.value.length).toBe(2000);
  expect(cloudToolReview("write_file", { path: `/reports/${"x".repeat(250)}` }, "en")?.slots).toEqual({
    file: { kind: "object", title: "x".repeat(200) },
  });
  expect(cloudToolReview("web_search", {}, "en")).toBeNull();
});
