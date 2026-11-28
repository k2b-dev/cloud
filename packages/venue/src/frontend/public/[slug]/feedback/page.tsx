import { getLocale } from "@k2b/cloud/server";
import { MinimalLayout } from "@k2b/cloud/ssr";
import { ssr } from "../../../../config";
import { venueMessages } from "../../../../messages";
import { venueService } from "../../../../service";
import { GuestFeedbackPage } from "./guest-feedback-page";

export default ssr(async (c) => {
  const { t } = venueMessages.resolve([getLocale(c)]);
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Robots-Tag", "noindex");
  const id = c.req.param("id") ?? "";
  const internalStatus = id ? await venueService.publicStatus(id, new Date(), getLocale(c)) : null;
  const status = internalStatus ? await venueService.publicResources.projectPublicStatus(internalStatus) : null;
  c.get("page").title = status ? t.pageTitleFeedback({ name: status.venue.name }) : t.feedbackUnavailable;
  if (!status || !status.venue.feedbackEnabled) {
    if (!status) c.status(404);
    c.header("Cache-Control", "private, no-store");
  }

  // Like the guest page, the form follows the visitor's Cloud theme.
  return () => (
    <MinimalLayout c={c} ui="v2">
      <GuestFeedbackPage status={status} backUrl={`/app/venue/public/${encodeURIComponent(id)}`} />
    </MinimalLayout>
  );
});
