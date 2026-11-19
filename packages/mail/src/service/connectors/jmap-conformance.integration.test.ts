import { beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { discoverJmapFolders, verifyJmap } from "./jmap";
import { type JmapAccess, jmapBasicAuthorization } from "./jmap-client";

const configPath = process.env.MAIL_JMAP_CONFORMANCE_CONFIG;
const suite = configPath ? describe : describe.skip;

suite("JMAP read-only connector conformance", () => {
  let access: JmapAccess;
  beforeAll(async () => {
    if (!configPath) return;
    let config: unknown;
    try {
      config = await Bun.file(configPath).json();
    } catch {
      throw new Error("Could not read JMAP conformance configuration");
    }
    const parsed = z.object({ origin: z.string().url(), username: z.string().min(1), password: z.string().min(1) }).safeParse(config);
    if (!parsed.success) throw new Error("Invalid JMAP conformance configuration");
    access = {
      origin: parsed.data.origin,
      authorization: jmapBasicAuthorization(parsed.data.username, { kind: "password", password: parsed.data.password }),
      signal: new AbortController().signal,
    };
  });
  test("verifies the primary account and reads its folders without mutations", async () => {
    const account = await verifyJmap(access);
    expect(account.origin).toStartWith("https://");
    expect(account.accountId.length).toBeGreaterThan(0);
    const folders = await discoverJmapFolders(access);
    expect(new Set(folders.map((folder) => folder.mailboxId)).size).toBe(folders.length);
    expect(folders.some((folder) => folder.role === "inbox")).toBe(true);
    expect(folders.every((folder) => folder.uidValidity === null && folder.uidNext === null && folder.highestModseq === null)).toBe(true);
  });
});
