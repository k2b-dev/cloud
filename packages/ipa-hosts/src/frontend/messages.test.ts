import { describe, expect, test } from "bun:test";
import { hostMessages } from "./messages";

describe("IPA Hosts messages", () => {
  test("keeps every locale complete", () => expect(hostMessages.check()).toEqual([]));
  test("falls back from regional German", () => expect(hostMessages.resolve(["de-CH"]).t.hostgroups).toBe("Hostgruppen"));
});
