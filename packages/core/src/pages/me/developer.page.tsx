import { cloudMcpResourceUri, publicCloudOrigin } from "@k2b/cloud/api";
import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { coreSettings, readAccountCategoryPolicy, serviceAccountCredentials } from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import AccountHub, { AccountPageHeader, AccountProfileActions } from "./AccountHub";
import ApiKeysSettings from "./ApiKeysSettings.island";
import McpSetup from "./McpSetup.island";
import { accountMessages } from "./messages";

export default ssr<AuthContext>(async (c) => {
  const user = c.get("user");
  const categoryPolicy = await readAccountCategoryPolicy();
  const { t } = accountMessages.resolve([getLocale(c)]);
  const [rawAppName, rawAppUrl, freeIpaEnabledRaw, apiKeys] = await Promise.all([
    coreSettings.get<string>("app.name"),
    coreSettings.get<string>("app.url"),
    coreSettings.get<boolean>("freeipa.enable"),
    serviceAccountCredentials.listForDelegatedUser({ userId: user.id }),
  ]);
  const appName = rawAppName || "Cloud";
  const freeIpaEnabled = Boolean(freeIpaEnabledRaw);
  const cloudUrl = publicCloudOrigin(rawAppUrl);
  const cliInstallCommand = `curl -fsSL ${cloudUrl}/cli | sh`;
  const mcpResource = cloudMcpResourceUri(rawAppUrl);

  return () => (
    <Layout c={c} title={[{ title: t.start, href: "/" }, { title: t.account, href: "/me" }, { title: t.developer }]}>
      <AccountHub user={user} active="developer" loginLabel={categoryPolicy.login.label}>
        <div class="flex flex-col gap-2">
          <AccountPageHeader title={t.developer} description={t.developerDescription} />

          <section class="paper p-5 sm:p-6">
            <div class="mb-4">
              <h3 class="flex items-center gap-2 text-sm font-semibold text-primary">
                <i class="ti ti-plug-connected" aria-hidden="true" />
                Cloud MCP
              </h3>
              <p class="mt-1 text-xs text-dimmed">{t.cloudMcpDescription}</p>
            </div>
            <McpSetup endpoint={mcpResource} />
            <div class="mt-4 flex flex-col gap-2 text-xs text-dimmed">
              <p>{t.mcpOauthNotice}</p>
              <p>
                {t.mcpApiKeyBefore} <code class="font-mono text-secondary">CLOUD_API_KEY</code>. {t.mcpApiKeyAfter}
              </p>
              <a
                class="w-fit text-link hover:underline"
                href="https://github.com/k2b-dev/cloud/blob/main/docs-site/docs/en/platform/mcp.md"
              >
                {t.mcpGuide}
              </a>
            </div>
          </section>

          <ApiKeysSettings initialKeys={apiKeys} />

          <section class="paper p-5 sm:p-6">
            <div class="mb-4">
              <h3 class="flex items-center gap-2 text-sm font-semibold text-primary">
                <i class="ti ti-terminal-2" />
                Cloud CLI
              </h3>
              <p class="mt-1 text-xs text-dimmed">{t.cloudCliDescription}</p>
            </div>
            <code class="block overflow-x-auto rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] px-3 py-2 font-mono text-xs text-secondary">
              {cliInstallCommand}
            </code>
            <p class="mt-3 text-xs text-dimmed">
              {t.thenRun} <code class="font-mono text-secondary">cld login --server {cloudUrl}</code>.
            </p>
          </section>

          {user.provider === "ipa" && (
            <section class="paper p-5 sm:p-6">
              <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
                <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] text-secondary">
                  <i class="ti ti-key" />
                </span>
                <div class="min-w-0 flex-1">
                  <h3 class="text-sm font-semibold text-primary">{t.sshKeys}</h3>
                  <p class="mt-1 text-xs text-dimmed">{t.providerSshKeys({ count: user.ipa.sshPublicKeys.length })}</p>
                </div>
                <AccountProfileActions user={user} appName={appName} freeIpaEnabled={freeIpaEnabled} actions={["details"]} />
              </div>
            </section>
          )}
        </div>
      </AccountHub>
    </Layout>
  );
});
