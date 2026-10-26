import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cloud from "@k2b/cloud";
import type { User } from "@k2b/cloud/contracts";
import { auth } from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";

const root = mkdtempSync(join(tmpdir(), "core-consent-page-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
afterAll(() => rmSync(root, { recursive: true, force: true }));
const { default: handler } = await import("./consent.page");

const documents = [
  { kind: "terms", mode: "local", value: "Terms" },
  { kind: "privacy", mode: "local", value: "Privacy" },
] as const;
const version = createHash("sha256").update(JSON.stringify(documents)).digest("hex");
const pendingUser: User = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "consent-reader",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Ada",
  sn: "Reader",
  displayName: "Ada Reader",
  mail: "ada@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
};
const spies: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  spies.push(
    spyOn(auth.session, "getToken").mockReturnValue(null),
    spyOn(services.legalConsent, "pending").mockResolvedValue({ user: pendingUser, sid: "consent-session", authEpoch: 0 }),
    spyOn(services.legalConsent, "documents").mockResolvedValue({ documents: [...documents], version }),
    spyOn(cloud, "listLegalLinks").mockResolvedValue([]),
  );
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

test("the consent page renders the pending document version in a stable attribute", async () => {
  const app = new Hono().get("/auth/continue", ...handler);
  const response = await app.request("https://cloud.example.test/auth/continue");
  expect(response.status).toBe(200);
  // The nightly, release and Chat smokes read this attribute to accept the documents.
  const html = await response.text();
  expect(/data-legal-version="([a-f0-9]{64})"/.exec(html)?.[1]).toBe(version);
  expect(html).toContain(pendingUser.id);
});
