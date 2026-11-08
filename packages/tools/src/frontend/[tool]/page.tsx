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
import WebhookTester, { parseWebhookTesterState, type WebhookTesterInitialState } from "../tools/WebhookTester.island";

const toolComponents: Record<
  string,
  (props: {
    speedtestConfig?: { server: string; enabled: boolean };
    webhookState?: WebhookTesterInitialState;
    baseHref?: string;
  }) => JSX.Element
> = {
  mailto: () => <MailtoGenerator />,
  qr: () => <QrCodeGenerator />,
  encoding: () => <EncodingTool />,
  uuid: () => <UuidGenerator />,
  hash: () => <HashGenerator />,
  lorem: () => <LoremIpsumGenerator />,
  color: () => <ColorConverter />,
  "document-markdown": () => <DocumentMarkdown />,
  "markdown-pdf": () => <MarkdownPdf />,
  "image-converter": () => <ImageConverter />,
  image: () => <ImageProcessor />,
  encryption: () => <EncryptionTool />,
  password: () => <PasswordGenerator />,
  speedtest: (props) => <SpeedTest server={props.speedtestConfig?.server} enabled={props.speedtestConfig?.enabled} />,
  webhooks: (props) => <WebhookTester initialState={props.webhookState} baseHref={props.baseHref} />,
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
  const webhookState = tool.id === "webhooks" ? parseWebhookTesterState(new URL(c.req.url)) : undefined;
  const breadcrumbs = [{ title: labels.home, href: "/" }, { title: labels.appName, href: "/tools" }, { title: tool.name }];
  const regionLayout = tool.id === "image" || tool.id === "image-converter" || tool.id === "webhooks";

  return () => (
    <Layout c={c} fullPage workspaceSidebarCollapsible title={breadcrumbs}>
      <ToolsWorkspace activeToolId={tool.id} layout={regionLayout ? "regions" : "main"}>
        {regionLayout ? (
          renderTool?.({ speedtestConfig, webhookState, baseHref: `/tools/${tool.id}` })
        ) : (
          <div class="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col gap-4">
            <ShowToolHeader icon={tool.icon} name={tool.name} description={tool.description} />
            {renderTool?.({ speedtestConfig, baseHref: `/tools/${tool.id}` })}
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
