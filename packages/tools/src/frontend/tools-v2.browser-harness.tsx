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
import UuidGenerator from "./tools/UuidGenerator.island";

// One Tools screen on v2 per address: `?screen=catalog` (with `q`), or a tool id.
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
};

const params = new URL(location.href).searchParams;
render(
  () => (
    <LocaleProvider locale={params.get("locale") ?? "de"}>
      {(v2Screens[params.get("screen") ?? "catalog"] ?? v2Screens.catalog!)()}
    </LocaleProvider>
  ),
  document.getElementById("app")!,
);
