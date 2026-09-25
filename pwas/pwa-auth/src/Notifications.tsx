import { Button, InlineGuidance, LocaleProvider, NoticeCard, PanelDialog, StatusBadge, type StatusTone, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import { openDialog } from "./dialog";
import { authMessages } from "./i18n";
import type { Installation } from "./install";
import type { Preferences } from "./preferences";
import type { Push, PushState } from "./push";

type Messages = ReturnType<typeof authMessages.resolve>["t"];
const status: Record<PushState, { tone: StatusTone; label: (t: Messages) => string; help: (t: Messages) => string }> = {
  active: { tone: "ok", label: (t) => t.pushStatusActive, help: (t) => t.pushActiveHelp },
  inactive: { tone: "warning", label: (t) => t.pushStatusInactive, help: (t) => t.pushInactiveHelp },
  default: { tone: "info", label: (t) => t.pushStatusDefault, help: (t) => t.pushDefaultHelp },
  denied: { tone: "error", label: (t) => t.pushStatusDenied, help: (t) => t.pushDeniedHelp },
  "not-installed": { tone: "warning", label: (t) => t.pushStatusNotInstalled, help: (t) => t.pushNotInstalledHelp },
  unsupported: { tone: "neutral", label: (t) => t.pushStatusUnsupported, help: (t) => t.pushUnsupportedHelp },
  checking: { tone: "running", label: (t) => t.pushStatusChecking, help: (t) => t.pushCheckingHelp },
};

/** Onboarding: the tap on this card is the user gesture iOS requires for the permission prompt. */
export function PushCard(props: { push: Push; installation: Installation; showInstall: () => void }) {
  const locale = useLocale();
  const t = createMemo(() => authMessages.resolve([locale()]).t);
  const visible = () =>
    !props.push.dismissed() &&
    ((props.push.state() === "default" && props.installation.installed()) || props.push.state() === "not-installed");
  return (
    <Show when={visible()}>
      <NoticeCard
        class="auth-push-card"
        tone="info"
        icon="ti ti-bell"
        title={t().pushCardTitle}
        detail={props.push.state() === "not-installed" ? t().pushCardInstallBody : t().pushCardBody}
        aria-label={t().pushCardTitle}
      >
        <Show when={props.push.failed()}>
          <p role="alert">{t().pushFailed}</p>
        </Show>
        <div class="auth-push-card__actions">
          <Button variant="ghost" onClick={props.push.dismiss}>
            {t().pushLater}
          </Button>
          <Show
            when={props.push.state() === "not-installed"}
            fallback={
              <Button loading={props.push.busy()} onClick={() => void props.push.enable()}>
                {t().pushEnable}
              </Button>
            }
          >
            <Button onClick={props.showInstall}>{t().pushShowSteps}</Button>
          </Show>
        </div>
      </NoticeCard>
    </Show>
  );
}

function DeniedSteps(props: { platform: Installation["platform"] }) {
  const locale = useLocale();
  const t = createMemo(() => authMessages.resolve([locale()]).t);
  const steps = createMemo(() =>
    props.platform === "apple-mobile"
      ? [t().pushDeniedIos1, t().pushDeniedIos2, t().pushDeniedIos3]
      : props.platform === "android"
        ? [t().pushDeniedAndroid1, t().pushDeniedAndroid2, t().pushDeniedAndroid3]
        : [t().pushDeniedBrowser1, t().pushDeniedBrowser2, t().pushDeniedBrowser3],
  );
  return (
    <ol class="auth-push-steps">
      <For each={steps()}>{(step) => <li>{step}</li>}</For>
    </ol>
  );
}

export function NotificationSettings(props: { push: Push; installation: Installation; showInstall: () => void; close: () => void }) {
  const locale = useLocale();
  const t = createMemo(() => authMessages.resolve([locale()]).t);
  const [sent, setSent] = createSignal(false);
  const current = () => status[props.push.state()];
  const test = async () => {
    setSent(false);
    setSent(await props.push.test());
  };
  return (
    <PanelDialog>
      <PanelDialog.Header title={t().notifications} />
      <PanelDialog.Body>
        <div class="auth-flow auth-push-settings">
          <div class="auth-push-status">
            <span>{t().pushStatus}</span>
            <StatusBadge tone={current().tone} label={current().label(t())} />
          </div>
          <p>{current().help(t())}</p>
          <Show when={props.push.state() === "denied"}>
            <DeniedSteps platform={props.installation.platform} />
          </Show>
          <Show when={props.push.state() === "active" || props.push.state() === "default"}>
            <p class="auth-quiet">{t().pushPrivacy}</p>
          </Show>
          <Show when={props.push.failed()}>
            <InlineGuidance tone="danger" role="alert">
              {t().pushFailed}
            </InlineGuidance>
          </Show>
          <Show when={sent() && !props.push.failed()}>
            <InlineGuidance tone="success" role="status">
              {t().pushTestSent}
            </InlineGuidance>
          </Show>
        </div>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <div class="auth-dialog-actions">
          <Button variant="ghost" onClick={props.close}>
            {t().close}
          </Button>
          <Switch>
            <Match when={props.push.state() === "default"}>
              <Button loading={props.push.busy()} onClick={() => void props.push.enable()}>
                {t().pushAsk}
              </Button>
            </Match>
            <Match when={props.push.state() === "inactive"}>
              <Button loading={props.push.busy()} onClick={() => void props.push.retry()}>
                {t().pushReconnect}
              </Button>
            </Match>
            <Match when={props.push.state() === "active"}>
              <Button loading={props.push.busy()} onClick={() => void test()}>
                {t().pushTest}
              </Button>
            </Match>
            <Match when={props.push.state() === "not-installed"}>
              <Button onClick={props.showInstall}>{t().pushShowSteps}</Button>
            </Match>
          </Switch>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

export function openNotifications(push: Push, installation: Installation, preferences: Preferences, showInstall: () => void) {
  return openDialog(
    (close) => (
      <LocaleProvider locale={preferences.locale()}>
        <NotificationSettings push={push} installation={installation} showInstall={showInstall} close={() => close()} />
      </LocaleProvider>
    ),
    { panelClassName: "k2b-dialog k2b-dialog--small", contentClassName: "k2b-dialog__viewport" },
  );
}
