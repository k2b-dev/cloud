import type { JSX } from "solid-js";
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
import type { ToolId } from "../tools/registry";
import SpeedTest from "../tools/SpeedTest.island";
import UuidGenerator from "../tools/UuidGenerator.island";
import WebhookTester from "../tools/WebhookTester.island";
import type { WebhookTesterData } from "../tools/webhook-page-data";

export type ToolProps = {
  speedtestConfig?: { server: string; enabled: boolean };
  webhookData?: WebhookTesterData;
};

/** Every tool on v2, by registry id; each island renders the whole Tools screen with its own panes. */
// A `Record` over every `ToolId`: a tool in the registry without a v2 screen fails the type check.
export const toolScreens: Record<ToolId, (props: ToolProps) => JSX.Element> = {
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
