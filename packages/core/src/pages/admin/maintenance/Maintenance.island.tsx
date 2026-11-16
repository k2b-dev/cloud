import { MAINTENANCE_MESSAGE_MAX_LENGTH, type MaintenanceStatus } from "@k2b/cloud/contracts/maintenance";
import type { DateContext } from "@k2b/stdlib";
import { Button, DescriptionList, NoticeCard, prompts, Section, StatusBadge, TextInput, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { bypassHref, maintenanceApi, waitForGatewayMaintenance } from "./client";
import { type MaintenanceAdminMessages, maintenanceAdminMessages } from "./messages";
import { activeRows } from "./rows";
import { parseEndTime } from "./time";

/** While maintenance runs, the apps line follows the apps as they come back. */
const REFRESH_MS = 10_000;

type Busy = "start" | "until" | "stop" | null;
type Failure = { message: string; retry?: () => void };

const timeError = (reason: "format" | "past", t: MaintenanceAdminMessages) => (reason === "past" ? t.timePassed : t.timeInvalid);

export default function Maintenance(props: {
  initial: MaintenanceStatus;
  /** App names by id, for apps that are still starting and so are not in the registry. */
  appNames: Record<string, string>;
  dateConfig: DateContext;
  /** This page's path; the bypass link brings the browser back here. */
  path: string;
}) {
  const locale = useLocale();
  const t = () => maintenanceAdminMessages.resolve([locale()]).t;
  const timeZone = () => props.dateConfig.timeZone ?? "UTC";
  const [status, setStatus] = createSignal(props.initial);
  const [message, setMessage] = createSignal("");
  const [until, setUntil] = createSignal("");
  const [untilError, setUntilError] = createSignal<string>();
  const [busy, setBusy] = createSignal<Busy>(null);
  const [failure, setFailure] = createSignal<Failure | null>(null);
  const [now, setNow] = createSignal(Date.now());

  onMount(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
      if (!status().active || busy() !== null || document.visibilityState === "hidden") return;
      maintenanceApi.status().then(
        (next) => {
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
      await waitForGatewayMaintenance();
      window.location.assign(bypassHref(link.url, props.path));
    } catch {
      setFailure({ message: t().startedNoLink, retry: () => void enter() });
      setBusy(null);
    }
  };

  const start = async () => {
    let end: string | undefined;
    if (until().trim()) {
      const parsed = parseEndTime(until(), timeZone());
      if (!parsed.ok) {
        setUntilError(timeError(parsed.reason, t()));
        return;
      }
      end = parsed.iso;
    }
    setUntilError(undefined);
    setFailure(null);
    setBusy("start");
    try {
      setStatus(await maintenanceApi.on({ ...(message().trim() ? { message: message() } : {}), ...(end ? { until: end } : {}) }));
    } catch {
      setFailure({ message: t().startFailed });
      setBusy(null);
      return;
    }
    // From here on everyone else sees the maintenance page; the button stays busy until this browser is let in.
    await enter();
  };

  const moveEnd = async () => {
    const values = await prompts.form({
      title: t().moveEndTitle,
      icon: "ti ti-clock",
      confirmText: t().moveEndSave,
      fields: {
        until: {
          type: "text",
          label: t().newEnd,
          placeholder: t().timePlaceholder,
          validate: (value) => {
            const parsed = parseEndTime(value ?? "", timeZone());
            return parsed.ok ? null : timeError(parsed.reason, t());
          },
        },
      },
    });
    if (!values) return;
    const parsed = parseEndTime(values.until, timeZone());
    if (!parsed.ok) return;
    setFailure(null);
    setBusy("until");
    try {
      setStatus(await maintenanceApi.until(parsed.iso));
    } catch {
      setFailure({ message: t().moveEndFailed, retry: () => void moveEnd() });
    } finally {
      setBusy(null);
    }
  };

  const stop = async () => {
    const confirmed = await prompts.confirm(t().stopText, { title: t().stopTitle, icon: "ti ti-barrier-block-off", confirmText: t().stop });
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

  const failureNotice = () => (
    <Show when={failure()}>
      {(current) => (
        <NoticeCard
          tone="danger"
          icon="ti ti-alert-circle"
          role="alert"
          actions={
            <Show when={current().retry}>
              {(retry) => (
                <Button type="button" size="sm" variant="secondary" onClick={() => retry()()}>
                  {t().retry}
                </Button>
              )}
            </Show>
          }
        >
          {current().message}
        </NoticeCard>
      )}
    </Show>
  );

  return (
    <Section
      size="md"
      title={t().title}
      data-maintenance-admin={status().active ? "active" : "off"}
      meta={
        <StatusBadge
          tone={status().active ? "warning" : "neutral"}
          variant={status().active ? "text" : "dot"}
          icon={status().active ? "ti ti-barrier-block" : null}
          label={status().active ? t().active : t().off}
          labels={[t().active, t().off]}
        />
      }
      description={status().active ? t().activeDescription : t().offDescription}
      footer={
        <Show
          when={status().active}
          fallback={
            <>
              <span class="me-auto min-w-40 flex-1 text-xs text-dimmed">
                {t().cliHintBefore}
                <code>cld admin maintenance off</code>
                {t().cliHintAfter}
              </span>
              <Button type="button" variant="primary" loading={busy() === "start"} loadingLabel={t().starting} onClick={() => void start()}>
                {t().start}
              </Button>
            </>
          }
        >
          <Button
            type="button"
            variant="secondary"
            class="ms-auto"
            disabled={busy() !== null}
            loading={busy() === "until"}
            onClick={() => void moveEnd()}
          >
            {t().moveEnd}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={busy() !== null && busy() !== "stop"}
            loading={busy() === "stop" || busy() === "start"}
            loadingLabel={t().stopping}
            onClick={() => void stop()}
          >
            {t().stop}
          </Button>
        </Show>
      }
    >
      <div class="flex flex-col gap-4">
        <Show
          when={status().active}
          fallback={
            <>
              <TextInput
                multiline
                lines={2}
                label={t().message}
                description={t().messageHint}
                maxLength={MAINTENANCE_MESSAGE_MAX_LENGTH}
                value={message}
                disabled={busy() !== null}
                onValueChange={setMessage}
              />
              <TextInput
                class="sm:max-w-xs"
                label={t().until}
                description={t().untilHint}
                placeholder={t().timePlaceholder}
                inputMode="numeric"
                autocomplete="off"
                value={until}
                error={untilError}
                disabled={busy() !== null}
                onValueChange={(value) => {
                  setUntil(value);
                  setUntilError(undefined);
                }}
              />
            </>
          }
        >
          <DescriptionList
            layout="rows"
            items={activeRows(status(), { t: t(), locale: locale(), dateConfig: props.dateConfig, appNames: props.appNames, now: now() })}
          />
        </Show>
        {failureNotice()}
      </div>
    </Section>
  );
}
