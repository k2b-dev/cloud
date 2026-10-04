import { expect, test } from "bun:test";
import { liveTopicConfig } from "./live";

// Every process of an application declares this topic. Sync rejects a declaration
// that differs from the existing stream, so a changed value breaks rolling deploys:
// ship it under a new topic id instead of editing these numbers.
test("the live topic configuration is frozen", () => {
  expect(liveTopicConfig("contacts")).toEqual({
    id: "cloud:live:contacts",
    owner: "cloud",
    retention: { maxAgeMs: 86_400_000, maxBytes: 67_108_864 },
    maxPayloadBytes: 40_960,
    deadLetterRetention: { maxBytes: 1_048_576 },
  });
});
