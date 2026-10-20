import { expect, test } from "bun:test";
import { notebooksTextLog } from "./yjs-sync";

test("Notebooks keeps the installed document log declaration exactly", () => {
  expect(notebooksTextLog.topicConfig).toEqual({
    id: "cloud:notebooks:yjs",
    retention: { maxAgeMs: 604_800_000, maxBytes: 1_073_741_824 },
    deadLetterRetention: { maxBytes: 16_777_216 },
    maxPayloadBytes: 8_104_096,
  });
});
