import { Button, Dialog, Facts, Text } from "@k2b/ui/v2";
import { createSignal, type JSX } from "solid-js";
import { useAccountMessages } from "./AccountWorkspace";
import { createMcpSetupSnippets } from "./mcp-setup";

const MCP_GUIDE = "https://github.com/k2b-dev/cloud/blob/main/docs-site/docs/en/platform/mcp.md";

/** How to connect the Cloud CLI and agents (MCP) to this Cloud: the commands to copy, behind one deed. */
export const useConnectSetup = (props: { mcpEndpoint: string; cloudUrl: string }) => {
  const t = useAccountMessages();
  const [open, setOpen] = createSignal(false);
  const mcp = createMcpSetupSnippets(props.mcpEndpoint);
  const snippet = (label: string, value: string) => ({ label, value, copy: value, mono: true });
  const dialog = (): JSX.Element => (
    <Dialog
      title={t().connectTitle}
      open={open()}
      onOpenChange={setOpen}
      foot={
        <Button variant="primary" onClick={() => setOpen(false)}>
          {t().done}
        </Button>
      }
    >
      <Text muted>{t().cloudCliDescription}</Text>
      <Facts
        items={[snippet(t().install, `curl -fsSL ${props.cloudUrl}/cli | sh`), snippet(t().thenRun, `cld login --server ${props.cloudUrl}`)]}
      />
      <Text muted>{t().cloudMcpDescription}</Text>
      <Facts
        items={[
          snippet(t().endpoint, mcp.endpoint),
          snippet(t().codexBrowserLogin, mcp.codexOAuth),
          snippet(t().claudeBrowserLogin, mcp.claudeOAuth),
          snippet(t().codexApiKey, mcp.codexApiKey),
          snippet(t().claudeApiKey, mcp.claudeApiKey),
        ]}
      />
      <Text muted type="meta">
        {t().mcpOauthNotice} {t().mcpApiKeyBefore} CLOUD_API_KEY. {t().mcpApiKeyAfter} <Text href={MCP_GUIDE}>{t().mcpGuide}</Text>
      </Text>
    </Dialog>
  );
  return { open: () => setOpen(true), dialog };
};
