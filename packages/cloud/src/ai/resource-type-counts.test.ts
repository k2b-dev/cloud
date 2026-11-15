import { describe, expect, test } from "bun:test";
import type { CapabilityRegistryEntry } from "../contracts/registry";
import { describeAiResourceTypeCounts } from "./resource-type-counts";

const entry = {
  appId: "mail",
  appName: "Mail",
  appIcon: "ti ti-mail",
  appDescription: "Mail",
  endpoint: "http://mail.invalid",
  manifest: {
    protocolVersion: 2,
    appId: "mail",
    types: [
      { localId: "message", title: "Mail message", description: "One message.", count: { one: "mail", other: "mails" } },
      { localId: "folder", title: "Mail folder", description: "A folder." },
    ],
    queries: [],
    actions: [],
    commands: [],
    events: [],
  },
  presentation: {
    baseLocale: "en",
    translations: { de: { types: { message: { title: "Mail-Nachricht", count: { one: "Mail", other: "Mails" } } } } },
  },
} as unknown as CapabilityRegistryEntry;
const listRegistry = async () => [entry];

describe("resource type counts", () => {
  test("a type names its nouns per locale; a type without them and an unknown app stay out", async () => {
    const counts = new Map([
      ["mail.message", 3],
      ["mail.folder", 2],
      ["spaces.task", 1],
    ]);
    expect(await describeAiResourceTypeCounts(counts, "de", { listRegistry })).toEqual(new Map([["mail.message", "3 Mails"]]));
    expect(await describeAiResourceTypeCounts(new Map([["mail.message", 1]]), "en", { listRegistry })).toEqual(
      new Map([["mail.message", "1 mail"]]),
    );
  });
});
