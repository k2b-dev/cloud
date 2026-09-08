import { Button, dialogCore, LocaleProvider, PanelDialog, SegmentedControl, useLocale } from "@k2b/ui";
import { createMemo, Show } from "solid-js";
import { authMessages } from "./i18n";
import type { Preferences } from "./preferences";

export function Settings(props: { preferences: Preferences; section: "language" | "theme"; close: () => void }) {
  const locale = useLocale();
  const t = createMemo(() => authMessages.resolve([locale()]).t);
  return (
    <PanelDialog>
      <PanelDialog.Header title={props.section === "language" ? t().language : t().appearance} />
      <PanelDialog.Body>
        <div class="auth-settings">
          <Show when={props.section === "language"}>
            <SegmentedControl
              ariaLabel={t().language}
              value={props.preferences.language}
              onValueChange={props.preferences.setLanguage}
              options={[
                { value: "system", label: t().system },
                { value: "de", label: "Deutsch" },
                { value: "en", label: "English" },
              ]}
            />
          </Show>
          <Show when={props.section === "theme"}>
            <SegmentedControl
              ariaLabel={t().appearance}
              value={props.preferences.theme}
              onValueChange={props.preferences.setTheme}
              options={[
                { value: "system", label: t().system },
                { value: "light", label: t().light },
                { value: "dark", label: t().dark },
              ]}
            />
          </Show>
        </div>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <Button onClick={props.close}>{t().done}</Button>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

export function openSettings(preferences: Preferences, section: "language" | "theme") {
  return dialogCore.open(
    (close) => (
      <LocaleProvider locale={preferences.locale()}>
        <Settings preferences={preferences} section={section} close={() => close()} />
      </LocaleProvider>
    ),
    { panelClassName: "k2b-dialog k2b-dialog--small", contentClassName: "k2b-dialog__viewport" },
  );
}
