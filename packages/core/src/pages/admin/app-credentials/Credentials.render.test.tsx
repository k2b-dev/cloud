import { expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { serviceAccountCredentials } from "@k2b/cloud/services";
import { createConfig } from "@k2b/ssr";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "cloud-workload-credentials-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: Credentials } = await import("./Credentials.island");
type Listing = Awaited<ReturnType<typeof serviceAccountCredentials.listOverview>>;

for (const locale of ["en", "de"]) {
  test(`disabled workload account offers recovery after reload in ${locale}`, () => {
    setSystemTime(new Date("2026-10-29T12:00:00Z"));
    try {
      const initial: Listing = {
        page: 1,
        perPage: 20,
        total: 1,
        hasNext: false,
        items: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            serviceAccountId: "22222222-2222-4222-8222-222222222222",
            name: "Runtime 0123456789abcdef",
            kind: "api_token",
            status: "revoked",
            tokenPrefix: "cld_preview",
            scopes: ["identity:invoke"],
            expiresAt: "2026-10-29T13:00:00Z",
            createdAt: "2026-10-29T12:00:00Z",
            createdBy: null,
            lastUsedAt: null,
            revokedAt: "2026-10-29T12:00:00Z",
            revokedBy: null,
            owner: { type: "resource", appId: "mail", resourceType: "cloud.app", resourceId: "mail" },
            serviceAccount: {
              id: "22222222-2222-4222-8222-222222222222",
              name: "mail workload",
              kind: "resource_bound",
              status: "disabled",
              delegatedUserId: null,
              appId: "mail",
              resourceType: "cloud.app",
              resourceId: "mail",
              createdBy: null,
              createdAt: "2026-10-29T12:00:00Z",
            },
          },
        ],
      };
      const html = renderToString(() =>
        createComponent(LocaleProvider, {
          locale,
          get children() {
            return createComponent(Credentials, { apps: [{ id: "mail", name: "Mail" }], initial });
          },
        }),
      );
      expect(html).toContain(locale === "en" ? "Enable app workload access" : "App-Hintergrundzugriff aktivieren");
      expect(html).toContain(locale === "en" ? "App workload access disabled" : "App-Hintergrundzugriff deaktiviert");
      expect(html).not.toContain("bg-emerald-500/10");
    } finally {
      setSystemTime();
    }
  });
}
