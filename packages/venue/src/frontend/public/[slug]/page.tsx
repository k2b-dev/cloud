import { getLocale } from "@k2b/cloud/server";
import { coreSettings } from "@k2b/cloud/services";
import { MinimalLayout } from "@k2b/cloud/ssr";
import { LocaleProvider } from "@k2b/ui";
import { ssr } from "../../../config";
import { venueMessages } from "../../../messages";
import { venueService } from "../../../service";
import {
  buildPublicVenueFeedbackUrl,
  parseVenuePublicDisplayHeight,
  parseVenuePublicRefresh,
  resolveVenuePublicOrigin,
} from "../../public-runtime";
import PublicVenuePage from "./PublicVenuePage.island";

export default ssr(async (c) => {
  const { t } = venueMessages.resolve([getLocale(c)]);
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  const id = c.req.param("id") ?? "";
  const internalStatus = id ? await venueService.publicStatus(id, new Date(), getLocale(c)) : null;
  const status = internalStatus ? await venueService.publicResources.projectPublicStatus(internalStatus) : null;
  if (!status) c.status(404);
  c.get("page").title = status?.venue.name ?? t.venueFallbackTitle;

  const requestOrigin = new URL(c.req.raw.url).origin;
  const appUrl = await coreSettings.get<string>("app.url").catch(() => "");
  const origin = resolveVenuePublicOrigin(appUrl, requestOrigin);

  const displayHeight = parseVenuePublicDisplayHeight(c.req.query("height"));
  const page = () => (
    <PublicVenuePage
      venueId={id}
      initialStatus={status}
      displayHeight={displayHeight}
      feedbackUrl={buildPublicVenueFeedbackUrl(origin, id)}
      refresh={parseVenuePublicRefresh(c.req.query("refresh"))}
    />
  );

  // The monitor hangs in the venue and always renders dark. The scrollable page follows the visitor's Cloud
  // theme like every Cloud page; a visitor without one gets the light theme.
  if (displayHeight === "full") {
    c.get("page").theme = "dark";
    return () => <LocaleProvider locale={getLocale(c)}>{page()}</LocaleProvider>;
  }
  return () => (
    <MinimalLayout c={c} preferences={false}>
      {page()}
    </MinimalLayout>
  );
});
