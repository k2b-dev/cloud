import { LocaleProvider } from "@k2b/ui";
import type { JSX } from "solid-js";
import { render } from "solid-js/web";
import ToolCatalog from "./ToolCatalog.island";
import ColorConverter from "./tools/ColorConverter.island";
import EncodingTool from "./tools/EncodingTool.island";
import EncryptionTool from "./tools/EncryptionTool.island";
import HashGenerator from "./tools/HashGenerator.island";
import LoremIpsumGenerator from "./tools/LoremIpsumGenerator.island";
import MailtoGenerator from "./tools/MailtoGenerator.island";
import PasswordGenerator from "./tools/PasswordGenerator.island";
import QrCodeGenerator from "./tools/QrCodeGenerator.island";
import SpeedTest from "./tools/SpeedTest.island";
import UuidGenerator from "./tools/UuidGenerator.island";
import WebhookTester from "./tools/WebhookTester.island";
import { webhookHarness } from "./tools/webhook-tester.harness";

// One Tools screen on v2 per address: `?screen=catalog` (with `q`), or a tool id. The webhook tester stands at its own
// address (`/tools/webhooks`, with `?fixture=`), because its links lead there.
export const v2Screens: Record<string, () => JSX.Element> = {
  catalog: () => <ToolCatalog search={new URL(location.href).searchParams.get("q") ?? ""} />,
  password: () => <PasswordGenerator />,
  uuid: () => <UuidGenerator />,
  lorem: () => <LoremIpsumGenerator />,
  hash: () => <HashGenerator />,
  encoding: () => <EncodingTool />,
  color: () => <ColorConverter />,
  mailto: () => <MailtoGenerator />,
  encryption: () => <EncryptionTool />,
  qr: () => <QrCodeGenerator />,
  speedtest: () => <SpeedTest server="https://speedtest.example.test" enabled />,
  // once per page: a prop getter would build a fresh fixture store (and fetch stand-in) on every read of `data`
  webhooks: () => {
    const data = webhookHarness();
    return <WebhookTester data={data} />;
  },
};

const params = new URL(location.href).searchParams;
render(
  () => (
    <LocaleProvider locale={params.get("locale") ?? "de"}>
      {(v2Screens[location.pathname === "/tools/webhooks" ? "webhooks" : (params.get("screen") ?? "catalog")] ?? v2Screens.catalog!)()}
    </LocaleProvider>
  ),
  document.getElementById("app")!,
);
