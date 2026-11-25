import { MAINTENANCE_MESSAGE_MAX_LENGTH, type MaintenanceStatus } from "@k2b/cloud/contracts/maintenance";
import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import type { DateContext } from "@k2b/stdlib";
import { DateTimePicker, useLocale } from "@k2b/ui";
import { Band, Bar, Button, Chip, Dialog, Facts, Field, Inline, Input, type NavProps, Notice, Pane, Text } from "@k2b/ui/v2";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { enterThroughBypass, maintenanceApi, refusedField } from "./client";
import { maintenanceAdminMessages } from "./messages";
import MoveEndDialog from "./move-end-dialog";
import { activeRows } from "./rows";
import { isFutureEnd, todayKey } from "./time";

/** While maintenance runs, the apps line follows the apps as they come back. */
const REFRESH_MS = 10_000;

type Busy = "start" | "stop" | null;
type Failure = { message: string; retry?: () => void };

/**
 * Maintenance mode on v2: off, a note and a planned end to start it; on, who started it, until when and which apps are
 * back, with the end to move and the switch off. Starting lets this browser past the wall through the gateway.
 */
export default function Maintenance(props: {
  /** The admin bar, from the server. */
  nav: NavProps;
  initial: MaintenanceStatus;
  /** App names by id, for apps that are still starting and so are not in the registry. */
  appNames: Record<string, string>;
  dateConfig: DateContext;
  /** This page's path; the bypass link brings the browser back here. */
  path: string;
  /** The planned end the start form suggests, chosen by the server so both renders show the same field. */
  suggestedEnd: string;
}) {
  const locale = useLocale();
  const t = () => maintenanceAdminMessages.resolve([locale()]).t;
  const timeZone = () => props.dateConfig.timeZone ?? "UTC";
  /** The pickers commit instants in the viewer's zone and name it; without a zone they would commit wall times. */
  const pickerConfig = () => ({ ...props.dateConfig, timeZone: timeZone(), locale: locale() });
  const [status, setStatus] = createSignal(props.initial);
  const [message, setMessage] = createSignal("");
  // A planned end is suggested; clearing the field means none.
  const [until, setUntil] = createSignal<string | null>(props.suggestedEnd);
  const [untilError, setUntilError] = createSignal<string>();
  const [messageError, setMessageError] = createSignal<string>();
  const [busy, setBusy] = createSignal<Busy>(null);
  const [failure, setFailure] = createSignal<Failure | null>(null);
  const [now, setNow] = createSignal(Date.now());
  const [moving, setMoving] = createSignal(false);

  // Every write bumps the generation, so a refresh that left before it never overwrites what the write returned.
  let generation = 0;
  const write = (next: MaintenanceStatus) => {
    generation += 1;
    setStatus(next);
  };

  onMount(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
      if (!status().active || busy() !== null || document.visibilityState === "hidden") return;
      const asked = generation;
      maintenanceApi.status().then(
        (next) => {
          if (asked !== generation) return;
          setStatus(next);
          setFailure((current) => (current?.message === t().refreshFailed ? null : current));
        },
        () => setFailure((current) => current ?? { message: t().refreshFailed }),
      );
    }, REFRESH_MS);
    onCleanup(() => clearInterval(timer));
  });

  /** Lets this browser past the wall it just raised: the gateway turns the link into a cookie and comes back here. */
  const enter = async () => {
    setBusy("start");
    setFailure(null);
    try {
      const link = await maintenanceApi.bypass();
      await enterThroughBypass(link.url, props.path);
      // The gateway now lets this browser through; the reload shows the running maintenance from the server.
      window.location.reload();
    } catch {
      setFailure({ message: t().startedNoLink, retry: () => void enter() });
      setBusy(null);
    }
  };

  const start = async () => {
    const end = until() ?? undefined;
    if (end && !isFutureEnd(end)) {
      setUntilError(t().timePassed);
      return;
    }
    setUntilError(undefined);
    setFailure(null);
    setBusy("start");
    setMessageError(undefined);
    try {
      write(await maintenanceApi.on({ ...(message().trim() ? { message: message() } : {}), ...(end ? { until: end } : {}) }));
    } catch (error) {
      // A refused field says why at that field (e.g. this browser's clock is ahead of the server's); anything else is general.
      const field = refusedField(error);
      if (field === "until") setUntilError(t().timePassed);
      else if (field === "message") setMessageError(t().messageTooLong);
      else setFailure({ message: t().startFailed });
      setBusy(null);
      return;
    }
    // From here on everyone else sees the maintenance page; the button stays busy until this browser is let in.
    await enter();
  };

  const stop = async () => {
    const confirmed = await Dialog.confirm({ title: t().stopTitle, description: t().stopText, confirm: t().stop });
    if (!confirmed) return;
    setFailure(null);
    setBusy("stop");
    try {
      await maintenanceApi.off();
      window.location.reload();
    } catch {
      setFailure({ message: t().stopFailed, retry: () => void stop() });
      setBusy(null);
    }
  };

  const facts = () =>
    activeRows(status(), { t: t(), locale: locale(), dateConfig: props.dateConfig, appNames: props.appNames, now: now() });

  return (
    <AdminWorkspace
      nav={props.nav}
      head={
        <Bar
          start={
            <Inline>
              <Text type="body">{t().title}</Text>
              <Show when={status().active} fallback={<Chip>{t().off}</Chip>}>
                <Chip status="warn">{t().active}</Chip>
              </Show>
            </Inline>
          }
        />
      }
    >
      <Pane label={t().title} scrollKey="admin-maintenance">
        <Text muted>
          {status().active ? (failure()?.message === t().startedNoLink ? t().activeLockedOut : t().activeDescription) : t().offDescription}
        </Text>
        <Show when={failure()}>
          {(current) => (
            <Notice
              tone="bad"
              actions={current().retry ? [{ label: t().retry, icon: "refresh", onClick: () => current().retry?.() }] : undefined}
            >
              {current().message}
            </Notice>
          )}
        </Show>
        <Show
          when={status().active}
          fallback={
            <>
              <Band>
                <Field name="message" label={t().message} hint={t().messageHint} error={messageError()} optional={t().optional}>
                  <Input
                    multiline
                    value={message()}
                    max={MAINTENANCE_MESSAGE_MAX_LENGTH}
                    disabled={busy() !== null}
                    onInput={(value) => {
                      setMessage(value);
                      setMessageError(undefined);
                    }}
                  />
                </Field>
                <Field name="until" label={t().until} hint={untilError() ?? t().untilHint} error={untilError()} optional={t().optional}>
                  {/* k2b-ui gap: no date and time picker in v2; the v1 picker stands in, with the time zone it names. */}
                  <DateTimePicker
                    aria-label={t().until}
                    placeholder={t().endPlaceholder}
                    value={until}
                    dateConfig={pickerConfig()}
                    min={todayKey(timeZone())}
                    clearable
                    disabled={busy() !== null}
                    onValueChange={(value) => {
                      setUntil(value);
                      setUntilError(value && !isFutureEnd(value) ? t().timePassed : undefined);
                    }}
                  />
                </Field>
              </Band>
              <Bar
                start={
                  <Text type="meta" muted>
                    {`${t().cliHintBefore}cld admin maintenance off${t().cliHintAfter}`}
                  </Text>
                }
                end={
                  <Button variant="primary" icon="barrier-block" busy={busy() === "start"} onClick={() => void start()}>
                    {t().start}
                  </Button>
                }
              />
            </>
          }
        >
          <Band>
            <Facts items={facts()} />
          </Band>
          <Bar
            end={
              <>
                <Button icon="clock" disabled={busy() !== null} onClick={() => setMoving(true)}>
                  {t().moveEnd}
                </Button>
                <Button
                  variant="primary"
                  icon="barrier-block-off"
                  disabled={busy() === "start"}
                  busy={busy() === "stop"}
                  onClick={() => void stop()}
                >
                  {t().stop}
                </Button>
              </>
            }
          />
        </Show>
      </Pane>
      <MoveEndDialog
        open={moving()}
        current={status().until}
        dateConfig={pickerConfig()}
        onClose={(next) => {
          setMoving(false);
          if (next) write(next);
        }}
      />
    </AdminWorkspace>
  );
}
