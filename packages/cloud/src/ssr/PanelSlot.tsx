import { Button, IconButton, type KeyboardPlatform, NoticeCard, Placeholder, ResizeSeparator, useLocale } from "@k2b/ui";
import { PANEL_MAX_WIDTH_REM, PANEL_MIN_WIDTH_REM, type PanelCookieState } from "../_internal/panel-cookie";
import { withPanelContext } from "../contracts/panel-context-plain";
import { platformMessages } from "./platform-messages";
import type { ShellData } from "./shell-data";

/** Server markup only. The shell loads its controller on demand. */
export default function PanelSlot(props: { panel: NonNullable<ShellData["panel"]>; state: PanelCookieState; platform?: KeyboardPlatform }) {
  const locale = useLocale();
  const t = platformMessages.resolve([locale()]).t;
  const provider = props.panel.providers.find((provider) => provider.id === props.panel.provider) ?? props.panel.providers[0];
  if (!provider) return null;
  const answer = props.panel.consent?.provider === provider.id ? props.panel.consent.allowed : null;
  const ask = props.state.open && provider.consent && answer === null;
  const allowed = !provider.consent || answer === true;
  const hasConsent = props.panel.providers.some((provider) => provider.consent);
  const tabs = props.panel.providers.length > 1;
  return (
    <aside
      class="cloud-panel"
      id="cloud-panel"
      data-cloud-panel=""
      aria-label={t.panel}
      data-state={props.state.open ? "loading" : "closed"}
      data-provider={provider.id}
      data-app-name={provider.appName}
      data-provider-consent={String(provider.consent)}
      data-context-allowed={String(allowed)}
      data-consent={ask ? "ask" : undefined}
    >
      <ResizeSeparator
        class="cloud-panel__resize"
        label={t.resizePanel}
        orientation="vertical"
        controls="cloud-panel"
        min={PANEL_MIN_WIDTH_REM}
        max={PANEL_MAX_WIDTH_REM}
        value={props.state.widthRem ?? 26}
        grow="start"
        onResize={() => {}}
      />
      <div class="cloud-panel__card">
        <button type="button" class="cloud-panel__grabber" data-cloud-panel-grow="" aria-label={t.enlargePanel}>
          <span aria-hidden="true" />
        </button>
        <div class="cloud-panel__head">
          {tabs ? (
            <div class="cloud-panel__tabs" role="tablist" aria-label={t.panels}>
              {props.panel.providers.map((item) => (
                <button
                  type="button"
                  role="tab"
                  class="cloud-panel__tab"
                  data-cloud-panel-provider={item.id}
                  aria-selected={item.id === provider.id}
                  aria-controls="cloud-panel-body"
                  tabindex={item.id === provider.id ? 0 : -1}
                >
                  <i class={item.icon} aria-hidden="true" />
                  <span class="cloud-panel__tab-label k2b-truncate-fade">{item.label}</span>
                </button>
              ))}
            </div>
          ) : (
            <h2 class="cloud-panel__title">
              <i class={provider.icon} aria-hidden="true" />
              <span>{provider.label}</span>
            </h2>
          )}
          {/* The controller mounts the ⋯ menu over this button; the place stays reserved for Core providers. */}
          {hasConsent && (
            <span
              class="cloud-panel__menu"
              data-cloud-panel-menu=""
              style={{ visibility: provider.consent ? "visible" : "hidden" }}
              inert={!provider.consent}
            >
              <IconButton label={t.panelMenu} title={t.panelMenu} aria-haspopup="menu" aria-expanded="false">
                <i class="ti ti-dots" aria-hidden="true" />
              </IconButton>
            </span>
          )}
          <IconButton
            label={t.closePanel}
            title={`${t.closePanel} (${props.platform === "apple" ? "⌘J" : "Ctrl+J"})`}
            data-cloud-panel-close=""
          >
            <i class="ti ti-x" aria-hidden="true" />
          </IconButton>
        </div>
        <div class="cloud-panel__body" id="cloud-panel-body" role={tabs ? "tabpanel" : undefined}>
          {hasConsent && (
            // The shell asks, not the provider: the question sits above the provider page, which loads without context.
            <NoticeCard
              class="cloud-panel__consent"
              tone="neutral"
              data-cloud-panel-consent=""
              role="region"
              tabindex="-1"
              aria-labelledby="cloud-panel-consent-title"
              title={
                <span id="cloud-panel-consent-title" data-cloud-panel-consent-title="">
                  {t.panelConsentTitle({ app: provider.appName })}
                </span>
              }
              detail={<span data-cloud-panel-consent-body="">{t.panelConsentBody({ app: provider.appName })}</span>}
            >
              <div class="cloud-panel__consent-actions">
                <Button size="sm" variant="primary" data-cloud-panel-consent-answer="allow">
                  {t.panelConsentAllow}
                </Button>
                <Button size="sm" variant="secondary" data-cloud-panel-consent-answer="deny">
                  {t.panelConsentDeny}
                </Button>
              </div>
              {/* A failed save reports in this reserved line, so the question never grows. */}
              <p class="cloud-panel__consent-error" data-cloud-panel-consent-error="" role="status" />
            </NoticeCard>
          )}
          <div class="cloud-panel__skeleton" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          {/* Lazy: below 768 px the open cookie leaves the slot hidden, and a hidden iframe must not load its provider. */}
          {props.state.open && (
            <iframe
              class="cloud-panel__frame"
              src={withPanelContext(provider.href, allowed ? props.panel.context : null)}
              title={provider.label}
              loading="lazy"
              data-cloud-panel-frame={provider.id}
            />
          )}
          <div class="cloud-panel__fallback">
            <Placeholder
              state="error"
              variant="panel"
              title={t.panelLoadFailed}
              description={t.panelNotResponding({ label: provider.label })}
              action={<Button data-cloud-panel-retry="">{t.retry}</Button>}
            />
          </div>
          <div class="cloud-panel__shield" aria-hidden="true" />
          <div class="cloud-panel__closing" aria-hidden="true">
            <span>
              <i class="ti ti-x" />
              {t.releaseClosesPanel}
            </span>
          </div>
        </div>
      </div>
      <div role="status" class="k2b-sr-only" data-cloud-panel-status="">
        {props.state.open ? t.panelLoading({ label: provider.label }) : ""}
      </div>
    </aside>
  );
}
