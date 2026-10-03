import { cloudMcpResourceUri, publicCloudOrigin } from "@k2b/cloud/api";
import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { coreSettings, readAccountCategoryPolicy, serviceAccountCredentials } from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import { SettingsSection } from "@k2b/ui";
import { ssr } from "../../config";
import AccountHub, { AccountPage, AccountProfileActions } from "./AccountHub";
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
        <AccountPage title={t.developer} description={t.developerDescription}>
          <SettingsSection title="Cloud MCP" subtitle={t.cloudMcpDescription}>
            {/* Islands render as display: contents, so the section's spacing needs a real box. */}
            <div>
              <McpSetup endpoint={mcpResource} />
            </div>
            <div class="flex flex-col gap-2 text-xs text-dimmed">
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
          </SettingsSection>

          <ApiKeysSettings initialKeys={apiKeys} />

          <SettingsSection title="Cloud CLI" subtitle={t.cloudCliDescription}>
            <code class="block overflow-x-auto rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] px-3 py-2 font-mono text-xs text-secondary">
              {cliInstallCommand}
            </code>
            <p class="text-xs text-dimmed">
              {t.thenRun} <code class="font-mono text-secondary">cld login --server {cloudUrl}</code>.
            </p>
          </SettingsSection>

          {user.provider === "ipa" && (
            <SettingsSection
              title={t.sshKeys}
              subtitle={t.providerSshKeys({ count: user.ipa.sshPublicKeys.length })}
              actions={<AccountProfileActions user={user} appName={appName} freeIpaEnabled={freeIpaEnabled} actions={["details"]} />}
            >
              {null}
            </SettingsSection>
          )}
        </AccountPage>
      </AccountHub>
    </Layout>
  );
});
