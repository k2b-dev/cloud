import { CopyButton, useLocale } from "@k2b/ui";
import { createMcpSetupSnippets } from "./mcp-setup";
import { accountMessages } from "./messages";

const Snippet = (props: { label: string; value: string }) => (
  <div>
    <div class="mb-1.5 flex items-center justify-between gap-3">
      <span class="text-xs font-medium text-secondary">{props.label}</span>
      <LocalizedCopyButton value={props.value} label={props.label} />
    </div>
    <pre class="overflow-x-auto rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] px-3 py-2 font-mono text-xs text-secondary">
      <code>{props.value}</code>
    </pre>
  </div>
);

const LocalizedCopyButton = (props: { value: string; label: string }) => {
  const locale = useLocale();
  const t = () => accountMessages.resolve([locale()]).t;
  return <CopyButton text={props.value} label={t().copyLabel({ label: props.label })} size="xs" />;
};

export default function McpSetup(props: { endpoint: string }) {
  const locale = useLocale();
  const t = () => accountMessages.resolve([locale()]).t;
  const snippets = createMcpSetupSnippets(props.endpoint);

  return (
    <div class="flex flex-col gap-4">
      <Snippet label={t().endpoint} value={snippets.endpoint} />
      <Snippet label={t().codexBrowserLogin} value={snippets.codexOAuth} />
      <Snippet label={t().claudeBrowserLogin} value={snippets.claudeOAuth} />
      <Snippet label={t().codexApiKey} value={snippets.codexApiKey} />
      <Snippet label={t().claudeApiKey} value={snippets.claudeApiKey} />
    </div>
  );
}
