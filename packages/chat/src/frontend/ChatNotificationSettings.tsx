import type { DateContext } from "@k2b/stdlib";
import { Button, ButtonLink, ChoiceChips, ChoiceList, DetailPanel, InlineGuidance, toast, useLocale } from "@k2b/ui";
import { createSignal, type JSX, onMount, Show } from "solid-js";
import type { z } from "zod";
import type { NotificationsSchema, NotificationUpdateSchema } from "../service/contracts";
import { type Conversation, errorMessage, useChatMessages } from "./chat-dialog";
import { untilLabel } from "./chat-format";

type Notifications = z.infer<typeof NotificationsSchema>;
type Level = Notifications["level"];
type Update = z.infer<typeof NotificationUpdateSchema>;
type MuteFor = Extract<Update, { level: "none" }>["for"];

/** Where Cloud keeps browser, email, and quiet hours for every app. */
export const NOTIFICATION_SETTINGS_HREF = "/me/notifications";

/**
 * The chat's notification level in its Info: three levels with the derived default marked, a duration for "Off", and
 * where browser, email, and quiet hours live. A choice saves at once; a failed save returns to the saved level and says
 * so in a fixed place below, with a retry, so nothing moves.
 */
export default function ChatNotificationSettings(props: {
  conversation: Pick<Conversation, "kind" | "channel">;
  notifications: Notifications;
  dateConfig: DateContext;
  now: () => Date;
  save: (input: Update) => Promise<unknown>;
}): JSX.Element {
  const t = useChatMessages();
  const locale = useLocale();
  const [pending, setPending] = createSignal<Level | null>(null);
  const [failed, setFailed] = createSignal<Update | null>(null);
  const [muteFor, setMuteFor] = createSignal<MuteFor | null>(
    props.notifications.level === "none" && !props.notifications.until ? "forever" : null,
  );
  const [blocked, setBlocked] = createSignal(false);
  const kind = () => (props.conversation.kind === "system" ? "system" : props.conversation.channel ? "channel" : "chat");
  const label = (level: Level) =>
    level === "all" ? t().notificationsAll : level === "mentions" ? t().notificationsMentions : t().notificationsNone;
  const value = () => pending() ?? props.notifications.level;

  onMount(() => {
    // Only this device can say whether its browser blocks notifications.
    void import("@k2b/cloud/browser/notifications")
      .then(({ browserNotificationClient }) => browserNotificationClient.state())
      .then((state) => setBlocked(state.supported && state.permission === "denied"))
      .catch(() => {});
  });

  // Saves run one after another, and the last choice wins: a choice made while one saves waits for it, and only the
  // last one's outcome shows.
  let queue = Promise.resolve();
  let latest = 0;
  const save = (input: Update) => {
    const mine = ++latest;
    setPending(input.level === "default" ? props.notifications.defaultLevel : input.level);
    setFailed(null);
    queue = queue.then(async () => {
      try {
        await props.save(input);
      } catch {
        if (mine === latest) setFailed(input);
      } finally {
        if (mine === latest) setPending(null);
      }
    });
  };
  const choose = (level: Level) => {
    if (level === value()) return;
    if (level === "none") {
      const duration = muteFor() ?? "8h";
      setMuteFor(duration);
      save({ level: "none", for: duration });
      return;
    }
    // The marked default follows the chat, so choosing it gives the choice back to the chat's rule.
    save(level === props.notifications.defaultLevel ? { level: "default" } : { level });
  };
  const chooseDuration = (duration: MuteFor) => {
    if (duration === muteFor()) return;
    setMuteFor(duration);
    save({ level: "none", for: duration });
  };
  const description = (level: Level) =>
    level === "all"
      ? kind() === "channel"
        ? t().notificationsAllChannel
        : kind() === "system"
          ? t().notificationsAllSystem
          : t().notificationsAllChat
      : level === "mentions"
        ? kind() === "system"
          ? t().notificationsMentionsSystem
          : t().notificationsMentionsChat
        : t().notificationsNoneDescription;
  const untilSentence = () => {
    const until = props.notifications.until;
    const config = { ...props.dateConfig, locale: locale() };
    return until
      ? t().mutedUntil({ time: untilLabel(until, props.now(), config), level: label(props.notifications.defaultLevel) })
      : t().mutedForever;
  };

  return (
    <DetailPanel.Section title={t().notificationsLabel}>
      <div class="chat-notifications">
        <ChoiceList
          aria-label={t().notificationsLabel}
          value={value}
          busy={pending() !== null}
          busyLabel={t().notificationsSaving}
          onValueChange={choose}
          options={(["all", "mentions", "none"] as const).map((level) => ({
            value: level,
            label: label(level),
            description: description(level),
            ...(props.notifications.defaultLevel === level ? { marker: t().notificationsDefault } : {}),
          }))}
          details={
            value() === "none" ? (
              <div class="chat-notifications__mute">
                <ChoiceChips
                  aria-label={t().muteForLabel}
                  value={muteFor}
                  onValueChange={chooseDuration}
                  options={[
                    { value: "1h", label: t().muteFor1h },
                    { value: "8h", label: t().muteFor8h },
                    { value: "1w", label: t().muteFor1w },
                    { value: "forever", label: t().muteForever },
                  ]}
                />
                <Show when={pending() === null && props.notifications.level === "none"}>
                  <p class="chat-notifications__note">{untilSentence()}</p>
                </Show>
              </div>
            ) : undefined
          }
        />
        {/* One fixed place for what went wrong or what this device blocks, so a message coming or going moves nothing. */}
        <div class="chat-notifications__status">
          <Show
            when={failed()}
            fallback={
              <Show when={blocked()}>
                <InlineGuidance tone="warning" icon="ti ti-bell-off">
                  {t().notificationsBlocked}
                </InlineGuidance>
              </Show>
            }
          >
            {(input) => (
              <InlineGuidance tone="danger" icon="ti ti-alert-circle" role="alert">
                {t().notificationsNotSaved({ level: label(props.notifications.level) })}{" "}
                <Button variant="text" size="xs" onClick={() => save(input())}>
                  {t().retry}
                </Button>
              </InlineGuidance>
            )}
          </Show>
        </div>
        <p class="chat-notifications__note">
          <i class="ti ti-settings" aria-hidden="true" />
          <span>
            {t().notificationsSettingsLead}{" "}
            <ButtonLink href={NOTIFICATION_SETTINGS_HREF} variant="text" size="xs">
              {t().notificationsSettingsLink}
            </ButtonLink>
          </span>
        </p>
        <Show when={props.notifications.following?.first ? props.notifications.following : null}>
          {(following) => (
            <div class="chat-notifications__following">
              <h4 class="chat-notifications__subtitle">{t().followOn}</h4>
              <p class="chat-notifications__note">
                <i class="ti ti-bell-ringing" aria-hidden="true" />
                <span>{t().followingSummary({ name: following().first!.name, more: following().count - 1 })}</span>
              </p>
            </div>
          )}
        </Show>
      </div>
    </DetailPanel.Section>
  );
}

/**
 * "You follow" in an item discussion's head: writing there follows it, and a press ends or resumes following. The
 * button keeps its place and size while it saves; a failure leaves the state as it was and says so.
 */
export function FollowToggle(props: { following: boolean; onToggle: (on: boolean) => Promise<unknown> }): JSX.Element {
  const t = useChatMessages();
  const [saving, setSaving] = createSignal(false);
  const toggle = async () => {
    if (saving()) return;
    setSaving(true);
    try {
      await props.onToggle(!props.following);
    } catch (failure) {
      toast.error(errorMessage(failure, t().followFailed));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Button
      size="sm"
      variant={props.following ? "subtle" : "ghost"}
      class="chat-follow"
      aria-pressed={props.following}
      loading={saving()}
      tooltip={t().followHint}
      onClick={() => void toggle()}
    >
      <i class={props.following ? "ti ti-bell-ringing" : "ti ti-bell-plus"} aria-hidden="true" />
      {props.following ? t().followOn : t().followOff}
    </Button>
  );
}
