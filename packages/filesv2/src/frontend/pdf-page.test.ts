import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { User } from "@k2b/cloud/contracts";
import { session } from "@k2b/cloud/services/session";
import type { RuntimeContext } from "@k2b/cloud/ssr";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { FilesError, filesService } from "../service";

// Page errors render Solid on the server; the transform must be installed before the page module loads.
const root = mkdtempSync(join(tmpdir(), "filesv2-pdf-page-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { inlinePdfHref } = await import("./file-preview");
const { pdfPage } = await import("./pdf-page");

const user: User = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "demo",
  provider: "local",
  profile: "user",
  roles: ["user", "local", "local/user"],
  givenname: "Demo",
  sn: "User",
  displayName: "Demo User",
  mail: "demo@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
};
const token = spyOn(session, "getToken").mockReturnValue(null);
const authenticate = spyOn(session, "authenticateRequest").mockResolvedValue(null);
const read = spyOn(filesService, "inlinePdf");
afterEach(() => {
  token.mockReturnValue(null);
  authenticate.mockResolvedValue(null);
  read.mockReset();
});
afterAll(() => {
  token.mockRestore();
  authenticate.mockRestore();
  read.mockRestore();
});
const signIn = () => {
  token.mockReturnValue("demo-session");
  authenticate.mockResolvedValue({ user, data: { userId: user.id, sid: "demo", authEpoch: 0, expiresAt: "2099-01-01T00:00:00Z" } });
};

const server = new Hono<{ Variables: { runtime: RuntimeContext } }>()
  .use("*", async (c, next) => {
    c.set("runtime", { apps: [] });
    await next();
  })
  .route("/", pdfPage);
const href = inlinePdfHref("freeipa:users:5f0c", "Team Ordner/Aushang Flohmarkt (Demo).pdf");
const open = (locale = "en") => server.request(href, { headers: { "Accept-Language": locale } });

test("the Files preview opens a PDF under the Files page address, ending in the file name", () => {
  expect(href).toBe("/app/filesv2/pdf/freeipa%3Ausers%3A5f0c/Team%20Ordner/Aushang%20Flohmarkt%20(Demo).pdf");
});

test("a signed-out or expired session goes to sign-in and comes back to the PDF", async () => {
  token.mockReturnValue("expired-session");
  const response = await open();
  expect(response.status).toBe(302);
  const target = new URL(response.headers.get("location")!, "https://cloud.test");
  expect(target.pathname).toBe("/auth/login");
  expect(target.searchParams.get("redirectTo")).toBe(href);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(read).not.toHaveBeenCalled();
});

test("a stored PDF streams inline with its name, locked down and never cached", async () => {
  signIn();
  read.mockResolvedValue({ name: "Aushang Flohmarkt (Demo).pdf", length: "9", body: new Response("%PDF-1.7\n").body! });
  const response = await open();
  expect(read.mock.calls[0]?.[1]).toEqual({ baseId: "freeipa:users:5f0c", path: "Team Ordner/Aushang Flohmarkt (Demo).pdf" });
  expect(response.status).toBe(200);
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  expect(headers).toEqual({
    "content-type": "application/pdf",
    "content-disposition": `inline; filename="Aushang Flohmarkt (Demo).pdf"; filename*=UTF-8''Aushang%20Flohmarkt%20%28Demo%29.pdf`,
    "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
    "cross-origin-resource-policy": "same-origin",
    "content-length": "9",
  });
  expect(await response.text()).toBe("%PDF-1.7\n");
});

test("a path the account may not read is a localized access page", async () => {
  signIn();
  read.mockRejectedValue(new FilesError("forbidden", 403));
  const response = await open("de");
  expect(response.status).toBe(403);
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const body = await response.text();
  expect(body).toContain('lang="de"');
  expect(body).toContain("Zugriff verweigert");
  expect(body).not.toContain('"code"');
});

test("a file that is not a PDF is a localized page that leads back to it in Files", async () => {
  signIn();
  read.mockRejectedValue(new FilesError("not_pdf"));
  for (const [locale, title, action] of [
    ["en", "This file is not a PDF", "Show in Files"],
    ["de", "Diese Datei ist kein PDF", "In Dateien anzeigen"],
  ] as const) {
    const response = await open(locale);
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain(title);
    expect(body).toContain(action);
    expect(body).toContain(
      'href="/app/filesv2?base=freeipa%3Ausers%3A5f0c&amp;path=Team+Ordner&amp;file=Team+Ordner%2FAushang+Flohmarkt+%28Demo%29.pdf"',
    );
    expect(body).not.toContain("not_pdf");
  }
});

test("a path beyond the stored-path limit is a missing page before any storage read", async () => {
  signIn();
  const response = await server.request(`/app/filesv2/pdf/base/${"a/".repeat(2048)}b.pdf`);
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(read).not.toHaveBeenCalled();
});
