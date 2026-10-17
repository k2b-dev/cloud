import { Button, IconButton, type KeyboardPlatform, Placeholder, ResizeSeparator, useLocale } from "@k2b/ui";
import { PANEL_MAX_WIDTH_REM, PANEL_MIN_WIDTH_REM, type PanelCookieState } from "../_internal/panel-cookie";
import { platformMessages } from "./platform-messages";
import type { ShellData } from "./shell-data";

/** Server markup only. The shell loads its controller on demand. */
export default function PanelSlot(props: { panel: NonNullable<ShellData["panel"]>; state: PanelCookieState; platform?: KeyboardPlatform }) {
  const locale = useLocale();
  const t = platformMessages.resolve([locale()]).t;
  const provider = props.panel.providers.find((provider) => provider.id === props.panel.provider) ?? props.panel.providers[0];
  if (!provider) return null;
  const tabs = props.panel.providers.length > 1;
  return (
    <aside
      class="cloud-panel"
      id="cloud-panel"
      data-cloud-panel=""
      aria-label={t.panel}
      data-state={props.state.open ? "loading" : "closed"}
      data-provider={provider.id}
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
                  <span class="cloud-panel__tab-label">{item.label}</span>
                </button>
              ))}
            </div>
          ) : (
            <h2 class="cloud-panel__title">
              <i class={provider.icon} aria-hidden="true" />
              <span>{provider.label}</span>
            </h2>
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
          <div class="cloud-panel__skeleton" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          {props.state.open && (
            <iframe class="cloud-panel__frame" src={provider.href} title={provider.label} data-cloud-panel-frame={provider.id} />
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
            <i class="ti ti-x" />
            <span>{t.releaseClosesPanel}</span>
          </div>
        </div>
      </div>
      <div role="status" class="k2b-sr-only" data-cloud-panel-status="">
        {props.state.open ? t.panelLoading({ label: provider.label }) : ""}
      </div>
    </aside>
  );
}
