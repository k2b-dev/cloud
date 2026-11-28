import { Cover, Empty, Pane, useLocale, Workspace } from "@k2b/ui/v2";
import { type JSX, Show } from "solid-js";
import type { PublicStatus } from "../../../../contracts";
import { venueMessages } from "../../../../messages";
import { GuestUnavailable, Head } from "../guest-page";
import GuestFeedback from "./GuestFeedback.island";

/**
 * The venue's feedback page: one task under the same head. The form is the only island; a venue that takes no
 * feedback says so with the way back to its page, and an unknown venue shows the page that reveals nothing.
 */
export const GuestFeedbackPage = (props: { status: PublicStatus | null; backUrl: string }): JSX.Element => {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  return (
    <Show when={props.status} fallback={<GuestUnavailable />}>
      {(status) => {
        const name = () => status().venue.name;
        return (
          <Workspace head={<Head status={status()} t={t()} />}>
            {/* k2b-ui gap: G1 (coordinator, after #4227): the 560 measure of one task; the form spans the window until then */}
            <Pane label={t().feedback}>
              {/* the slim banner says where the guest is; without one nothing stands here */}
              <Cover src={status().venue.bannerBase64 ?? undefined} alt="" slim />
              <Show
                when={status().venue.feedbackEnabled}
                fallback={
                  <Empty
                    icon="message-off"
                    text={t().feedbackClosedNow({ name: name() })}
                    action={{ label: name().length > 28 ? t().backToVenuePage : t().backToVenue({ name: name() }), href: props.backUrl }}
                  />
                }
              >
                <GuestFeedback venueId={status().venue.id} venueName={name()} backUrl={props.backUrl} />
              </Show>
            </Pane>
          </Workspace>
        );
      }}
    </Show>
  );
};
