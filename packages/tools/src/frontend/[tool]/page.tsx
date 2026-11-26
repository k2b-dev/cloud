import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import type { JSX } from "solid-js";
import { readSpeedtestConfig } from "../../api/speedtest";
import { ssr } from "../../config";
import { ToolsWorkspace } from "../ToolsWorkspace";
import ColorConverter from "../tools/ColorConverter.island";
import DocumentMarkdown from "../tools/DocumentMarkdown.island";
import EncodingTool from "../tools/EncodingTool.island";
import EncryptionTool from "../tools/EncryptionTool.island";
import HashGenerator from "../tools/HashGenerator.island";
import ImageConverter from "../tools/ImageConverter.island";
import ImageProcessor from "../tools/ImageProcessor.island";
import LoremIpsumGenerator from "../tools/LoremIpsumGenerator.island";
import MailtoGenerator from "../tools/MailtoGenerator.island";
import MarkdownPdf from "../tools/MarkdownPdf.island";
import PasswordGenerator from "../tools/PasswordGenerator.island";
import QrCodeGenerator from "../tools/QrCodeGenerator.island";
import { registryMessages, resolveRegistry } from "../tools/registry";
import SpeedTest from "../tools/SpeedTest.island";
import UuidGenerator from "../tools/UuidGenerator.island";
import WebhookTester from "../tools/WebhookTester.island";
import { loadWebhookTester, type WebhookTesterData } from "../tools/webhook-page-data";

type ToolProps = {
  speedtestConfig?: { server: string; enabled: boolean };
  webhookData?: WebhookTesterData;
};


/** The tools on v2; each island renders the whole Tools screen with its own panes. */
const v2Tools: Partial<Record<string, (props: ToolProps) => JSX.Element>> = {
  "document-markdown": () => <DocumentMarkdown />,
  "markdown-pdf": () => <MarkdownPdf />,
  "image-converter": () => <ImageConverter />,
  image: () => <ImageProcessor />,
  speedtest: (props) => <SpeedTest server={props.speedtestConfig?.server} enabled={props.speedtestConfig?.enabled} />,
  webhooks: (props) => (props.webhookData ? <WebhookTester data={props.webhookData} /> : null),
  password: () => <PasswordGenerator />,
  uuid: () => <UuidGenerator />,
  lorem: () => <LoremIpsumGenerator />,
  hash: () => <HashGenerator />,
  encoding: () => <EncodingTool />,
  mailto: () => <MailtoGenerator />,
  color: () => <ColorConverter />,
  encryption: () => <EncryptionTool />,
  qr: () => <QrCodeGenerator />,
};

export default ssr<AuthContext>(async (c) => {
  const toolId = c.req.param("toolId");
  if (!toolId) return ssr.error(c, 404);
  const locale = getLocale(c);
  const tool = resolveRegistry(locale).toolById(toolId);
  const labels = registryMessages.resolve([locale]).t;

  if (!tool) return ssr.error(c, 404);

  const renderTool = toolComponents[tool.id];
  const speedtestConfig = tool.id === "speedtest" ? await readSpeedtestConfig() : undefined;
  const webhookData = tool.id === "webhooks" ? await loadWebhookTester(c, new URL(c.req.url)) : undefined;
  const breadcrumbs = [{ title: labels.home, href: "/" }, { title: labels.appName, href: "/tools" }, { title: tool.name }];
  const regionLayout = false;
  // A tool rebuilt on v2 is its own whole screen (the Tools frame comes with it); the others keep the v1 frame until
  // they move too.
  const v2 = v2Tools[tool.id];
  if (v2)
    return () => (
      <Layout c={c} fullWidth ui="v2" title={breadcrumbs}>
        {v2({ speedtestConfig, webhookData })}
      </Layout>
    );

  return () => (
    <Layout c={c} fullPage workspaceSidebarCollapsible title={breadcrumbs}>
      <ToolsWorkspace activeToolId={tool.id} layout={regionLayout ? "regions" : "main"}>
        {regionLayout ? (
          renderTool?.({})
        ) : (
          <div class="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col gap-4">
            <ShowToolHeader icon={tool.icon} name={tool.name} description={tool.description} />
            {renderTool?.({})}
          </div>
        )}
      </ToolsWorkspace>
    </Layout>
  );
});

const ShowToolHeader = (props: { icon: string; name: string; description: string }) => (
  <header class="tools-tool-header flex items-center gap-3" style="view-transition-name: tool-heading">
    <div class="k2b-icon-tile app-accent-text h-10 w-10">
      <i class={`${props.icon} text-xl`} />
    </div>
    <div class="min-w-0">
      <h1 class="text-xl font-semibold text-primary">{props.name}</h1>
      <p class="text-sm text-dimmed">{props.description}</p>
    </div>
  </header>
);
