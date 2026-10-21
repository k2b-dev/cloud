import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import { appAccentStyle } from "../ssr/app-appearance";
import { createGlobalSearchHost } from "../ssr/global-search-host";
import { platformMessages } from "../ssr/platform-messages";
import ShellRuntime from "../ssr/ShellRuntime.island";
import type { ShellData } from "../ssr/shell-data";
import { openCloudResourcePicker } from "./resource-picker";
import { openGlobalSearch } from "./search";

/**
 * Opens the real global search, or with `?picker` the resource picker, for a browser test that answers
 * `/api/search` with invented, line-by-line results. `?app=<id>` narrows either one to one app.
 */
const params = new URLSearchParams(location.search);
const app = params.get("app") ?? undefined;
if (params.has("launcher")) {
  // Invented authorized shell data, rendered by the real ShellRuntime and global-search host.
  // Role filtering itself is covered at Layout's SSR seam; this harness does not simulate authentication.
  const locale = document.documentElement.lang || "en";
  const de = locale === "de";
  const data: ShellData = {
    apps: [
      { id: "tools", label: de ? "Werkzeuge" : "Tools", iconClass: "ti ti-tools", href: "/tools", match: "/tools", defaultVisible: false },
      ...(params.has("admin")
        ? [
            {
              id: "admin",
              label: platformMessages.resolve([locale]).t.admin,
              iconClass: "ti ti-settings",
              href: "/admin",
              match: "/admin",
              defaultVisible: false,
            },
          ]
        : []),
    ],
    searchLinks: {
      tools: [
        { label: "Tools", href: "/tools", keywords: ["utilities", "werkzeuge"] },
        { label: "QR Code", href: "/tools/qr", keywords: ["qr"] },
      ],
    },
    legalLinks: [],
    theme: "light",
  };
  const script = document.createElement("script");
  script.id = "cloud-shell-data";
  script.type = "application/json";
  script.textContent = JSON.stringify(data);
  document.body.append(script);
  const host = document.createElement("div");
  document.body.append(host);
  render(
    () => (
      <LocaleProvider locale={locale}>
        <ShellRuntime commands={{ searchResources: !params.has("public") }} />
      </LocaleProvider>
    ),
    host,
  );
  openGlobalSearch(app ? { scope: { appId: app, label: app } } : { query: params.get("q") ?? "" });
} else if (params.has("picker")) {
  // The page shell renders `<body class="k2b-ui app-accent-scope" style="…">` for an app page.
  const style = appAccentStyle(params.get("accent") ?? undefined);
  if (style) {
    document.body.classList.add("app-accent-scope");
    document.body.style.cssText = style;
  }
  void openCloudResourcePicker({ initialAppId: app });
} else createGlobalSearchHost(() => []).open(app ? { scope: { appId: app, label: params.get("label") ?? app } } : {});
