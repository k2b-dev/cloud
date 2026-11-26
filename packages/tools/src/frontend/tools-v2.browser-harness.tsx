import { LocaleProvider } from "@k2b/ui";
import type { JSX } from "solid-js";
import { render } from "solid-js/web";
import ToolCatalog from "./ToolCatalog.island";
import ColorConverter from "./tools/ColorConverter.island";
import EncodingTool from "./tools/EncodingTool.island";
import EncryptionTool from "./tools/EncryptionTool.island";
import HashGenerator from "./tools/HashGenerator.island";
import ImageConverter from "./tools/ImageConverter.island";
import ImageProcessor, { ImageProcessorView } from "./tools/ImageProcessor.island";
import { openFixturePhotos } from "./tools/image-processor/photo-fixture";
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
  "image-converter": () => <ImageConverter />,
  image: () => <ImageProcessor />,
  speedtest: () => <SpeedTest server="https://speedtest.example.test" enabled />,
  // once per page: a prop getter would build a fresh fixture store (and fetch stand-in) on every read of `data`
  webhooks: () => {
    const data = webhookHarness();
    return <WebhookTester data={data} />;
  },
};

// The photo editor with photos open: they are opened in the browser first, as a drop opens them.
const photoScreens: Record<string, { count: number; mode?: "markup"; reverse?: boolean }> = {
  "image-worst": { count: 4, reverse: true },
  "image-open": { count: 4 },
  "image-one": { count: 1 },
  "image-markup": { count: 2, mode: "markup" },
};

const params = new URL(location.href).searchParams;
const screen = location.pathname === "/tools/webhooks" ? "webhooks" : (params.get("screen") ?? "catalog");
const photos = photoScreens[screen];
// an IIFE bundle has no top-level await
void (async () => {
  const initialImages = photos ? await openFixturePhotos(photos.count, photos.reverse) : undefined;
  render(
    () => (
      <LocaleProvider locale={params.get("locale") ?? "de"}>
        {initialImages ? (
          <ImageProcessorView initialImages={initialImages} initialEditorMode={photos?.mode} />
        ) : (
          (v2Screens[screen] ?? v2Screens.catalog!)()
        )}
      </LocaleProvider>
    ),
    document.getElementById("app")!,
  );
})();
