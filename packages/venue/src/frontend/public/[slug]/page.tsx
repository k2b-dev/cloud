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
import { GuestPage, GuestUnavailable } from "./guest-page";
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

  const displayHeight = parseVenuePublicDisplayHeight(c.req.query("height"));
  const refresh = parseVenuePublicRefresh(c.req.query("refresh"));
  // "Rate" leads to the feedback page of the same address; the monitor's QR code needs the full address.
  const feedbackPath = `/app/venue/public/${encodeURIComponent(id)}/feedback`;

  // The monitor hangs in the venue and always renders dark. The guest page follows the visitor's Cloud theme like
  // every Cloud page; a visitor without a saved choice follows the device appearance.
  if (displayHeight === "full") {
    const appUrl = await coreSettings.get<string>("app.url").catch(() => "");
    const origin = resolveVenuePublicOrigin(appUrl, new URL(c.req.raw.url).origin);
    c.get("page").theme = "dark";
    return () => (
      <LocaleProvider locale={getLocale(c)}>
        <PublicVenuePage
          venueId={id}
          initialStatus={status}
          displayHeight={displayHeight}
          feedbackUrl={buildPublicVenueFeedbackUrl(origin, id)}
          refresh={refresh}
        />
      </LocaleProvider>
    );
  }
  // Only a page that refreshes itself in place needs a script; the guest page reads without one.
  return () => (
    <MinimalLayout c={c} ui="v2">
      {refresh ? (
        <PublicVenuePage venueId={id} initialStatus={status} displayHeight={displayHeight} feedbackUrl={feedbackPath} refresh />
      ) : status ? (
        <GuestPage status={status} feedbackUrl={feedbackPath} />
      ) : (
        <GuestUnavailable />
      )}
    </MinimalLayout>
  );
});
