import type { ServiceAccountCredential } from "@k2b/cloud/contracts";
import { Button, Facts, Pane, Row, Section, Text } from "@k2b/ui/v2";
import { Show } from "solid-js";
import AccountWorkspace, { useAccountMessages } from "./AccountWorkspace";
import { useApiKeys } from "./ApiKeysSection";
import type { AccountUserView } from "./account-view";
import { createMcpSetupSnippets } from "./mcp-setup";
import { type ProfileActionsUser, useProfileActions } from "./profile-actions";

const MCP_GUIDE = "https://github.com/k2b-dev/cloud/blob/main/docs-site/docs/en/platform/mcp.md";

export type DeveloperScreenProps = {
  user: AccountUserView;
  appTab: boolean;
  actionsUser: ProfileActionsUser;
  appName: string;
  freeIpaEnabled: boolean;
  apiKeys: ServiceAccountCredential[];
  openAiBaseUrl: string | null;
  mcpEndpoint: string;
  cloudUrl: string;
  now: string;
};

/** `/me/developer` on v2: API keys, the Cloud MCP and CLI set-up, and the FreeIPA account's SSH keys. */
export default function DeveloperScreen(props: DeveloperScreenProps) {
  const t = useAccountMessages();
  const keys = useApiKeys({ initialKeys: props.apiKeys, openAiBaseUrl: props.openAiBaseUrl, now: props.now });
  const actions = useProfileActions({ user: props.actionsUser, appName: props.appName, freeIpaEnabled: props.freeIpaEnabled });
  const mcp = createMcpSetupSnippets(props.mcpEndpoint);
  const snippet = (label: string, value: string) => ({ label, value, copy: value, mono: true });
  return (
    <AccountWorkspace
      user={props.user}
      active="developer"
      appTab={props.appTab}
      actions={
        <Button variant="primary" icon="plus" onClick={keys.create}>
          {t().createApiKey}
        </Button>
      }
      primary={{ label: t().createApiKey, icon: "plus", onClick: keys.create }}
    >
      <Pane label={t().developer}>
        {keys.section()}
        <Section
          icon="plug-connected"
          title="Cloud MCP"
          summary={t().cloudMcpDescription}
          more={{ label: t().mcpGuide, href: MCP_GUIDE, forward: true }}
        >
          <Facts
            items={[
              snippet(t().endpoint, mcp.endpoint),
              snippet(t().codexBrowserLogin, mcp.codexOAuth),
              snippet(t().claudeBrowserLogin, mcp.claudeOAuth),
              snippet(t().codexApiKey, mcp.codexApiKey),
              snippet(t().claudeApiKey, mcp.claudeApiKey),
            ]}
          />
          <Text muted>{t().mcpOauthNotice}</Text>
          <Text muted>
            {t().mcpApiKeyBefore} CLOUD_API_KEY. {t().mcpApiKeyAfter}
          </Text>
        </Section>
        <Section icon="terminal-2" title="Cloud CLI" summary={t().cloudCliDescription}>
          <Facts
            items={[
              snippet(t().install, `curl -fsSL ${props.cloudUrl}/cli | sh`),
              snippet(t().thenRun, `cld login --server ${props.cloudUrl}`),
            ]}
          />
        </Section>
        <Show when={props.actionsUser.provider === "ipa"}>
          <Section icon="key" title={t().sshKeys}>
            <Row
              icon="key"
              lines={[t().sshKeys, t().providerSshKeys({ count: props.actionsUser.ipa?.sshPublicKeys.length ?? 0 })]}
              action={actions.editDetails ? { label: t().contactAndSshDetails, onClick: actions.editDetails } : undefined}
            />
          </Section>
        </Show>
      </Pane>
      {keys.dialogs()}
      {actions.dialogs()}
    </AccountWorkspace>
  );
}
