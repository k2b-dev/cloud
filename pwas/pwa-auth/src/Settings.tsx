import { Button, LocaleProvider, PanelDialog, SegmentedControl, useLocale } from "@k2b/ui";
import { createMemo } from "solid-js";
import { openDialog } from "./dialog";
import { authMessages } from "./i18n";
import type { Preferences } from "./preferences";

export function Settings(props: { preferences: Preferences; close: () => void }) {
  const locale = useLocale();
  const t = createMemo(() => authMessages.resolve([locale()]).t);
  return (
    <PanelDialog>
      <PanelDialog.Header title={t().settings} />
      <PanelDialog.Body>
        <div class="auth-settings">
          <section>
            <h3>{t().language}</h3>
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
          </section>
          <section>
            <h3>{t().appearance}</h3>
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
          </section>
        </div>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <Button onClick={props.close}>{t().done}</Button>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

export function openSettings(preferences: Preferences) {
  return openDialog(
    (close) => (
      <LocaleProvider locale={preferences.locale()}>
        <Settings preferences={preferences} close={() => close()} />
      </LocaleProvider>
    ),
    { panelClassName: "k2b-dialog k2b-dialog--small", contentClassName: "k2b-dialog__viewport" },
  );
}
