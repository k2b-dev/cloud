import { announce, Band, Bar, Button, Choice, Empty, Facts, Field, Input, Notice, Text, useLocale } from "@k2b/ui/v2";
import { createSignal, Match, Show, Switch } from "solid-js";
import { apiClient } from "../../../../api/client";
import { venueMessages } from "../../../../messages";

/** The longest comment the server takes (`FeedbackInputSchema`). */
export const FEEDBACK_COMMENT_MAX = 2_000;

/** Why a send did not arrive: the connection, or too many ratings from one network in a short time. */
type Failure = "connection" | "limited";

type Sent = { rating: number; comment: string | null };

export type GuestFeedbackProps = {
  venueId: string;
  venueName: string;
  /** The venue's guest page, the one way on after sending or when feedback is closed. */
  backUrl: string;
};

/**
 * The feedback form of a venue's guest page: stars (required), a comment (optional), and send. A send that fails
 * keeps both and offers "Send again"; feedback that closed between loading and sending shows the closed page in place.
 * A duplicate send after an uncertain timeout costs one extra anonymous rating; the busy button blocks a second press.
 */
export default function GuestFeedback(props: GuestFeedbackProps) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  const [rating, setRating] = createSignal<number | null>(null);
  const [comment, setComment] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [failure, setFailure] = createSignal<Failure | null>(null);
  const [sent, setSent] = createSignal<Sent | null>(null);
  const [closed, setClosed] = createSignal(false);
  // a long name would crowd the bar: the way back then says where it leads in general words
  const back = () => (props.venueName.length > 28 ? t().backToVenuePage : t().backToVenue({ name: props.venueName }));
  const reading = (count: number) => t().ratingReading({ count, word: t().ratingWord({ count }) });

  const send = async () => {
    const stars = rating();
    if (stars === null || sending()) return;
    const input = { rating: stars, comment: comment().trim() || null };
    setSending(true);
    try {
      const response = await apiClient.public[":id"].feedback.$post({ param: { id: props.venueId }, json: input });
      // the form sends only what the server takes, so a refusal means feedback closed or the page went away
      if (response.status === 404 || response.status === 400) setClosed(true);
      else if (response.status === 429) setFailure("limited");
      else if (!response.ok) setFailure("connection");
      else {
        setFailure(null);
        setSent(input);
        announce(t().feedbackThanks);
      }
    } catch {
      setFailure("connection");
    } finally {
      setSending(false);
    }
  };

  return (
    <Switch
      fallback={
        <>
          <Band>
            <Text type="lead" weight="strong">
              {t().visitQuestion}
            </Text>
            <Text muted>{t().feedbackStored}</Text>
          </Band>
          <Band>
            {/* k2b-ui gap: G6 (W5, feat/ui-v2-star-rating): five stars as one radio group; until then a choice of 1 to 5 */}
            <Field label={t().rating} name="rating" required hint={rating() === null ? t().chooseStars : reading(rating()!)}>
              <Choice
                name="rating"
                options={[1, 2, 3, 4, 5].map((count) => ({
                  value: String(count),
                  label: t().ratingOption({ count, word: t().ratingWord({ count }) }),
                }))}
                value={rating() === null ? undefined : String(rating())}
                onChange={(value) => setRating(Number(value))}
                disabled={sending()}
              />
            </Field>
            <Field label={t().comment} name="comment" optional={t().commentOptional} hint={t().commentLimit}>
              <Input
                multiline
                rows={4}
                maxLength={FEEDBACK_COMMENT_MAX}
                placeholder={t().commentPlaceholder}
                value={comment()}
                onInput={setComment}
                disabled={sending()}
              />
            </Field>
          </Band>
          <Show when={failure()}>
            {(why) => (
              <Notice tone="bad" icon={why() === "limited" ? "clock" : "wifi-off"} title={t().notSent}>
                {why() === "limited" ? t().notSentRateLimit : t().notSentConnection}
              </Notice>
            )}
          </Show>
          {/* feedback needs a script: the island sends the form (decided; v2 has no form that sends without one) */}
          <Bar
            start={
              <Button variant="text" href={props.backUrl}>
                {back()}
              </Button>
            }
            end={
              <Button variant="primary" busy={sending()} disabled={rating() === null} onClick={() => void send()}>
                {failure() ? t().sendAgain : t().sendFeedback}
              </Button>
            }
          />
        </>
      }
    >
      <Match when={closed()}>
        <Empty icon="message-off" text={t().feedbackClosedNow({ name: props.venueName })} action={{ label: back(), href: props.backUrl }} />
      </Match>
      <Match when={sent()}>
        {(arrived) => (
          <>
            <Band>
              <Text type="lead" weight="strong">
                {t().feedbackThanks}
              </Text>
              <Text muted>{t().feedbackArrived}</Text>
            </Band>
            <Band>
              <Facts
                items={[
                  { label: t().rating, value: reading(arrived().rating) },
                  ...(arrived().comment ? [{ label: t().comment, value: arrived().comment }] : []),
                ]}
              />
            </Band>
            <Bar
              end={
                <Button href={props.backUrl} keep>
                  {back()}
                </Button>
              }
            />
          </>
        )}
      </Match>
    </Switch>
  );
}
