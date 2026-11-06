import type { AppInstallable } from "../contracts/installable";

export const kiosk = {
  path: "/app/inventory/counter/",
  name: "Inventory counter",
  shortName: "Counter",
  icon: "ti ti-pencil",
  themeColor: { light: "#fafafa", dark: "#090d12" },
  display: "standalone",
} satisfies AppInstallable;
