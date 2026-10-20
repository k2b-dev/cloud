import { AppWorkspace, LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import type { PublicConfiguration } from "../contracts";
import Settings from "./Settings";

const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const area = { enabled: false, root: "cloud", prefix: "", homes: "users", groups: "groups", archive: "archive" };
const configuration: PublicConfiguration = {
  url: "",
  activityRetentionDays: 365,
  cloud: { ...area, autoCreate: false, autoArchive: true },
  freeipa: { ...area, root: "freeipa" },
  collabora: { url: "", internalUrl: "", wopiOrigin: "", documentFormat: "odf" },
  tokenConfigured: false,
  unreadable: true,
};
render(
  () => (
    <LocaleProvider locale={document.documentElement.lang || "en"}>
      <AppWorkspace mobileSurface="flush">
        <AppWorkspace.Content>
          <Settings
            configuration={configuration}
            availability={{ localLinuxEnabled: true, freeipaEnabled: true }}
            onSaved={async () => {}}
            onDirtyChange={() => {}}
          />
        </AppWorkspace.Content>
      </AppWorkspace>
    </LocaleProvider>
  ),
  host,
);
