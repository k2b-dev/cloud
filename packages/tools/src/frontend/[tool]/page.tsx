import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import type { JSX } from "solid-js";
import { resolveSpeedtestBase } from "../../api/_url";
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
import MarkdownPdf from "../tools/MarkdownPdf.island";
import MailtoGenerator from "../tools/MailtoGenerator.island";
import PasswordGenerator from "../tools/PasswordGenerator.island";
import QrCodeGenerator from "../tools/QrCodeGenerator.island";
import { resolveRegistry } from "../tools/registry";
import SpeedTest from "../tools/SpeedTest.island";
import UuidGenerator from "../tools/UuidGenerator.island";
import WebhookTester, { parseWebhookTesterState, type WebhookTesterInitialState } from "../tools/WebhookTester.island";

const toolComponents: Record<
  string,
  (props: { speedtestBase?: string; webhookState?: WebhookTesterInitialState; baseHref?: string }) => JSX.Element
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
  speedtest: (props) => <SpeedTest cliBaseUrl={props.speedtestBase} />,
  webhooks: (props) => <WebhookTester initialState={props.webhookState} baseHref={props.baseHref} />,
};

export default ssr<AuthContext>(async (c) => {
  const toolId = c.req.param("toolId");
  if (!toolId) return ssr.error(c, 404);
  const tool = resolveRegistry(getLocale(c)).toolById(toolId);

  if (!tool) return ssr.error(c, 404);

  const renderTool = toolComponents[tool.id];
  const speedtestBase = tool.id === "speedtest" ? resolveSpeedtestBase(c) : undefined;
  const webhookState = tool.id === "webhooks" ? parseWebhookTesterState(new URL(c.req.url)) : undefined;
  const breadcrumbs = [{ title: "Start", href: "/" }, { title: "Tools", href: "/tools" }, { title: tool.name }];

  return () => (
    <Layout c={c} fullPage workspaceSidebarCollapsible={tool.id !== "webhooks"} title={breadcrumbs}>
      {tool.id === "webhooks" ? (
        renderTool?.({ webhookState, baseHref: `/tools/${tool.id}` })
      ) : (
        <ToolsWorkspace activeToolId={tool.id} layout={tool.id === "image" || tool.id === "image-converter" ? "regions" : "main"}>
          {tool.id === "image" || tool.id === "image-converter" ? (
            renderTool?.({ speedtestBase, baseHref: `/tools/${tool.id}` })
          ) : (
            <div class="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col gap-4">
              <ShowToolHeader show icon={tool.icon} name={tool.name} description={tool.description} />
              {renderTool ? renderTool({ speedtestBase, baseHref: `/tools/${tool.id}` }) : null}
            </div>
          )}
        </ToolsWorkspace>
      )}
    </Layout>
  );
});

const ShowToolHeader = (props: { show: boolean; icon: string; name: string; description: string }) =>
  props.show ? (
    <header class="tools-tool-header flex items-center gap-3" style="view-transition-name: tool-heading">
      <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] bg-[color-mix(in_srgb,var(--app-accent)_10%,var(--ui-surface-subtle))] app-accent-text">
        <i class={`${props.icon} text-xl`} />
      </div>
      <div class="min-w-0">
        <h1 class="text-xl font-semibold text-primary">{props.name}</h1>
        <p class="text-sm text-dimmed">{props.description}</p>
      </div>
    </header>
  ) : null;
