import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";

const root = mkdtempSync(join(tmpdir(), "accounts-automatic-rows-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: keysPage } = await import("./service-accounts/page");
const { default: auditPage } = await import("./audit/page");
const user = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "admin",
  provider: "local",
  profile: "user",
  roles: ["user", "admin"],
  givenname: "Ada",
  sn: "Admin",
  displayName: "Ada Admin",
  mail: null,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
} satisfies User;
const empty = { items: [], page: 1, perPage: 100, total: 0, hasNext: false };

for (const surface of ["service-accounts", "audit"] as const) {
  test(`${surface} renders translated counts and reload-safe toggles while preserving filters`, async () => {
    const list =
      surface === "service-accounts"
        ? spyOn(services.serviceAccountCredentials, "listOverview").mockResolvedValue({ ...empty, hiddenAutomaticCount: 32 })
        : spyOn(services.audit, "list").mockResolvedValue({ ...empty, hiddenAutomaticCount: 32 });
    const spies = [
      list,
      stubRailSnapshot(),
      spyOn(services.coreSettings, "get").mockResolvedValue(false),
      spyOn(services.accountsAppService.accountRequest, "list").mockResolvedValue(empty),
    ];
    const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
    app.use("*", async (c, next) => {
      c.set("actor", { kind: "user", user });
      c.set("user", user);
      c.set("runtime", { apps: [] });
      await next();
    });
    app.get(`/app/accounts/${surface}`, ...(surface === "service-accounts" ? keysPage : auditPage));
    const filters =
      surface === "service-accounts"
        ? "search=Runtime&kind=agent&status=revoked&extra=keep"
        : "search=Runtime&actor=Ada&target=Team&action=service_account_credential.create&actionGroup=service_accounts&serviceAccountId=machine&outcome=allowed&provider=local&days=7&extra=keep";
    try {
      for (const locale of ["en", "de"]) {
        const render = async (query: string) => {
          const response = await app.request(`/app/accounts/${surface}?${query}`, { headers: { "Accept-Language": locale } });
          const html = await response.text();
          expect(response.status, html).toBe(200);
          const links: { href: string; text: string }[] = [];
          await new HTMLRewriter()
            .on("p.text-dimmed a", {
              element(element) {
                links.push({ href: (element.getAttribute("href") ?? "").replaceAll("&amp;", "&"), text: "" });
              },
              text(text) {
                const link = links.at(-1);
                if (link) link.text += text.text;
              },
            })
            .transform(new Response(html))
            .text();
          return { html, link: links.find((link) => ["Show", "Hide", "Anzeigen", "Ausblenden"].includes(link.text)) };
        };
        const hidden = await render(`${filters}&page=3`);
        expect(hidden.html).toContain(
          surface === "service-accounts"
            ? locale === "de"
              ? "32 automatische App-Schlüssel sind ausgeblendet."
              : "32 automatic app keys are hidden."
            : locale === "de"
              ? "32 automatische App-Einträge sind ausgeblendet."
              : "32 automatic app entries are hidden.",
        );
        expect(list.mock.calls.at(-1)?.[0]?.filter?.automatic).toBe("hide");
        expect(hidden.link?.text).toBe(locale === "de" ? "Anzeigen" : "Show");
        if (!hidden.link) throw new Error("Show link missing");
        const shownParams = new URL(hidden.link.href, "https://example.test").searchParams;
        expect(Object.fromEntries(shownParams)).toEqual({ ...Object.fromEntries(new URLSearchParams(filters)), automatic: "1" });

        const shown = await render(`${shownParams}&page=4`);
        expect(list.mock.calls.at(-1)?.[0]?.filter?.automatic).toBe("include");
        expect(shown.html).toContain(
          surface === "service-accounts"
            ? locale === "de"
              ? "Automatische App-Schlüssel sind sichtbar. Sie rotieren selbst und verschwinden mit der Umstellung auf App-Schlüssel."
              : "Automatic app keys are visible. They rotate automatically and will disappear with the switch to app keys."
            : locale === "de"
              ? "Automatische App-Einträge sind sichtbar."
              : "Automatic app entries are visible.",
        );
        expect(shown.html).toContain('name="automatic" value="1"');
        expect(shown.link?.text).toBe(locale === "de" ? "Ausblenden" : "Hide");
        if (!shown.link) throw new Error("Hide link missing");
        expect(Object.fromEntries(new URL(shown.link.href, "https://example.test").searchParams)).toEqual(
          Object.fromEntries(new URLSearchParams(filters)),
        );
      }
      list.mockResolvedValue({ ...empty, hiddenAutomaticCount: 0 });
      const zero = await app.request(`/app/accounts/${surface}`);
      expect(await zero.text()).not.toContain('<a href="/app/accounts/' + surface + '?automatic=1"');
      const zeroShown = await app.request(`/app/accounts/${surface}?automatic=1`, { headers: { "Accept-Language": "en" } });
      expect(await zeroShown.text()).toContain(
        surface === "service-accounts" ? "Automatic app keys are visible." : "Automatic app entries are visible.",
      );
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
}
