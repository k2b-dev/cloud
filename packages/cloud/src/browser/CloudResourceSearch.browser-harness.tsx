import { appAccentStyle } from "../ssr/app-appearance";
import { createGlobalSearchHost } from "../ssr/global-search-host";
import { openCloudResourcePicker } from "./resource-picker";

/**
 * Opens the real global search, or with `?picker` the resource picker, for a browser test that answers
 * `/api/search` with invented, line-by-line results. `?app=<id>` narrows either one to one app.
 */
const params = new URLSearchParams(location.search);
const app = params.get("app") ?? undefined;
if (params.has("picker")) {
  // The page shell renders `<body class="k2b-ui app-accent-scope" style="…">` for an app page.
  const style = appAccentStyle(params.get("accent") ?? undefined);
  if (style) {
    document.body.classList.add("app-accent-scope");
    document.body.style.cssText = style;
  }
  void openCloudResourcePicker({ initialAppId: app });
} else createGlobalSearchHost(() => []).open(app ? { scope: { appId: app, label: params.get("label") ?? app } } : {});
