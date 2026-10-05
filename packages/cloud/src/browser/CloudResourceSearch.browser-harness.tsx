import { createGlobalSearchHost } from "../ssr/GlobalSearchDialog";
import { openCloudResourcePicker } from "./resource-picker";

/**
 * Opens the real global search, or with `?picker` the resource picker, for a browser test that answers
 * `/api/search` with invented, line-by-line results. `?app=<id>` narrows either one to one app.
 */
const params = new URLSearchParams(location.search);
const app = params.get("app") ?? undefined;
if (params.has("picker")) void openCloudResourcePicker({ initialAppId: app });
else createGlobalSearchHost(() => []).open(app ? { scope: { appId: app, label: params.get("label") ?? app } } : {});
