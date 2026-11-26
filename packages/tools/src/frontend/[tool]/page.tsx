import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import type { JSX } from "solid-js";
import { readSpeedtestConfig } from "../../api/speedtest";
import { ssr } from "../../config";
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

/** Every tool on v2; each island renders the whole Tools screen with its own panes. */
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

  const speedtestConfig = tool.id === "speedtest" ? await readSpeedtestConfig() : undefined;
  const webhookData = tool.id === "webhooks" ? await loadWebhookTester(c, new URL(c.req.url)) : undefined;
  const breadcrumbs = [{ title: labels.home, href: "/" }, { title: labels.appName, href: "/tools" }, { title: tool.name }];
  // Every tool is its own whole v2 screen: the Tools frame comes with its island.
  const render = v2Tools[tool.id];
  if (!render) return ssr.error(c, 404);
  return () => (
    <Layout c={c} fullWidth ui="v2" title={breadcrumbs}>
      {render({ speedtestConfig, webhookData })}
    </Layout>
  );
});
