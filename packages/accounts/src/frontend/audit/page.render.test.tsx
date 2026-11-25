import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as server from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import { stubRailSnapshot } from "../../../../../tests/fixtures/rail-snapshot";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";
import { adminApp } from "../notifications/render-fixture";
import { ACTOR_ID, AUDIT_EVENTS, SERVICE_ACCOUNT_ID, TARGET_USER_ID } from "./render-fixture";

const root = mkdtempSync(join(tmpdir(), "accounts-audit-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: handler } = await import("../activity/page");
const { default: formerPage } = await import("./page");

const page = (total = AUDIT_EVENTS.length, hiddenAutomaticCount = 0) => ({
  items: AUDIT_EVENTS,
  page: 1,
  perPage: 100,
  total,
  hasNext: false,
  hiddenAutomaticCount,
});

const withAudit = async (
  list: ReturnType<typeof page> | Error,
  run: (app: ReturnType<typeof adminApp>, spy: ReturnType<typeof spyOn<typeof services.audit, "list">>) => Promise<void>,
) => {
  const spy =
    list instanceof Error ? spyOn(services.audit, "list").mockRejectedValue(list) : spyOn(services.audit, "list").mockResolvedValue(list);
  const spies = [
    spy,
    stubRailSnapshot(),
    spyOn(server, "resolveDisplayNames").mockImplementation(async (entries) =>
      entries.map((entry) => ({
        ...entry,
        displayName:
          entry.principal.type === "user" && entry.principal.userId === TARGET_USER_ID
            ? "Milan Horvat"
            : entry.principal.type === "user"
              ? "Ada Renz"
              : entry.principal.type === "service_account"
                ? "Backup-Agent"
                : undefined,
      })),
    ),
    spyOn(services.accountsAppService.accountRequest, "countPending").mockResolvedValue(0),
  ];
  const app = adminApp();
  app.get("/app/accounts/activity", ...handler);
  app.get("/app/accounts/audit", ...formerPage);
  try {
    await run(app, spy);
  } finally {
    for (const entry of spies) entry.mockRestore();
  }
};

const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]!.replaceAll("&amp;", "&"));

test("the address filters the log on the server and the statements name what it filters by", async () => {
  const filters = `days=7&outcome=denied&action=accounts.user.create&actor=${ACTOR_ID}&target=${TARGET_USER_ID}&serviceAccountId=${SERVICE_ACCOUNT_ID}&actionGroup=service_accounts&provider=local&q=Runtime`;
  await withAudit(page(), async (app, list) => {
    const response = await app.request(`/app/accounts/activity?${filters}`, { headers: { "Accept-Language": "de" } });
    const html = await response.text();
    expect(response.status, html.slice(0, 300)).toBe(200);
    expect(list.mock.calls.at(-1)?.[0]).toEqual({
      pagination: { page: 1, perPage: 100 },
      filter: {
        automatic: "hide",
        search: "Runtime",
        actor: ACTOR_ID,
        target: TARGET_USER_ID,
        action: "accounts.user.create",
        actionGroup: "service_accounts",
        serviceAccountId: SERVICE_ACCOUNT_ID,
        outcome: "denied",
        provider: "local",
        days: 7,
      },
    });
    for (const statement of [
      "Zeitraum",
      "letzte 7 Tage",
      "Ausgeführt von",
      "Ada Renz",
      "Milan Horvat",
      "Backup-Agent",
      "Benutzer erstellen",
      "Abgelehnt",
    ])
      expect(html).toContain(statement);
    // an actor's name narrows the log to that actor; a user target leads to the user
    expect(hrefs(html)).toContain(`/app/accounts/users/${TARGET_USER_ID}`);
    expect(hrefs(html).some((href) => href.startsWith("/app/accounts/activity?") && href.includes(`actor=${ACTOR_ID}`))).toBe(true);
    // the event without a name is named by the server; an unknown action keeps its code
    expect(html).toContain("external.provider.sync");
  });
});

test("without a kind the activity is the audit log, 30 days back, and an address of the former audit page leads to the same log", async () => {
  await withAudit(page(), async (app, list) => {
    const plain = await app.request("/app/accounts/activity");
    expect(plain.status).toBe(200);
    expect(list.mock.calls.at(-1)?.[0]?.filter?.days).toBe(30);
    const old = await app.request("/app/accounts/audit?search=Runtime&outcome=failed&days=90&automatic=1&page=2");
    expect(old.status).toBe(302);
    expect(old.headers.get("location")).toBe("/app/accounts/activity?outcome=failed&days=90&automatic=1&page=2&q=Runtime");
  });
});

test("automatic app entries stay hidden with a way to show them, and the way back keeps every filter", async () => {
  const filters = "q=Runtime&actor=Ada&outcome=allowed&days=7&extra=keep";
  for (const locale of ["en", "de"]) {
    await withAudit(page(7, 32), async (app, list) => {
      const hidden = await app.request(`/app/accounts/activity?${filters}&page=1`, { headers: { "Accept-Language": locale } });
      const html = await hidden.text();
      expect(list.mock.calls.at(-1)?.[0]?.filter?.automatic).toBe("hide");
      expect(html).toContain(locale === "de" ? "32 automatische App-Einträge sind ausgeblendet." : "32 automatic app entries are hidden.");
      const show = hrefs(html).find((href) => href.includes("automatic=1"));
      expect(show).toBeDefined();
      const shownParams = new URL(show!, "https://example.test").searchParams;
      expect(Object.fromEntries(shownParams)).toEqual({ ...Object.fromEntries(new URLSearchParams(filters)), automatic: "1" });

      const shown = await app.request(`/app/accounts/activity?${shownParams}`, { headers: { "Accept-Language": locale } });
      const shownHtml = await shown.text();
      expect(list.mock.calls.at(-1)?.[0]?.filter?.automatic).toBe("include");
      expect(shownHtml).toContain(locale === "de" ? "Automatische App-Einträge sind sichtbar." : "Automatic app entries are visible.");
      expect(shownHtml).toContain(locale === "de" ? "Ausblenden" : "Hide");
      const hide = hrefs(shownHtml).find((href) => href.startsWith("/app/accounts/activity?q=Runtime") && !href.includes("automatic"));
      expect(Object.fromEntries(new URL(hide!, "https://example.test").searchParams)).toEqual(
        Object.fromEntries(new URLSearchParams(filters)),
      );
      // a part of the address that is no filter is named, not silently dropped
      expect(shownHtml).toContain("extra=keep");
    });
  }
  await withAudit(page(7, 0), async (app) => {
    const html = await (await app.request("/app/accounts/activity", { headers: { "Accept-Language": "en" } })).text();
    // nothing hidden, nothing shown: no word about automatic entries
    expect(html).not.toContain("Automatic app entries");
    expect(html).not.toContain("automatic app entries are hidden");
  });
});

test("a log that cannot be read shows its failure in place, the page stays", async () => {
  await withAudit(new Error("database down"), async (app) => {
    const response = await app.request("/app/accounts/activity", { headers: { "Accept-Language": "de" } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Das Audit-Protokoll konnte nicht geladen werden.");
    expect(html).toContain("Erneut versuchen");
  });
});
