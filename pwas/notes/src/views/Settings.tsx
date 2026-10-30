import { Button, ProgressBar, prompts, SegmentedControl, Switch, TextInput } from "@k2b/ui";
import { createResource, createSignal, Show } from "solid-js";
import type { AppLocale } from "../i18n";
import { preferences, type ThemeChoice } from "../prefs";
import { navigate } from "../router";
import { app, t } from "../state";
import { Icon } from "../ui/common";
import { openImport } from "./Import";
import { runExport } from "./menus";

const formatBytes = (bytes: number) =>
  new Intl.NumberFormat(preferences.locale(), { style: "unit", unit: bytes >= 1_000_000 ? "megabyte" : "kilobyte", maximumFractionDigits: 1 }).format(
    bytes >= 1_000_000 ? bytes / 1_000_000 : bytes / 1_000,
  );

function SettingsBody(props: { close: () => void }) {
  const [usage, { refetch }] = createResource(async () => (await app.store()?.usage()) ?? null);
  const [persistDenied, setPersistDenied] = createSignal(false);
  const [name, setName] = createSignal(preferences.name());

  const togglePersist = async (next: boolean) => {
    if (!next) return;
    const granted = (await app.store()?.requestPersistence()) ?? false;
    setPersistDenied(!granted);
    await refetch();
  };

  const clearAll = async () => {
    const confirmed = await prompts.confirm(t().clearAllConfirm, {
      title: t().clearAll,
      confirmText: t().deleteAction,
      confirmationPhrase: t().clearAllPhrase,
      variant: "danger",
    });
    if (!confirmed) return;
    await app.store()?.clearAll();
    preferences.clear();
    props.close();
    navigate("/", { replace: true });
  };

  return (
    <div class="n-dialog">
      <h2>{t().settings}</h2>
      <TextInput
        class="n-field"
        label={t().settingsName}
        description={t().settingsNameHelp}
        value={name}
        maxLength={32}
        icon={false}
        onValueChange={setName}
        onValueCommit={(value) => preferences.setName(value)}
        onBlur={() => preferences.setName(name())}
      />
      <div class="n-set">
        <span class="n-k">{t().appearance}</span>
        <SegmentedControl<ThemeChoice>
          ariaLabel={t().appearance}
          size="sm"
          value={preferences.theme}
          onValueChange={(theme) => preferences.setTheme(theme)}
          options={[
            { value: "system", label: t().themeSystem },
            { value: "light", label: t().themeLight },
            { value: "dark", label: t().themeDark },
          ]}
        />
      </div>
      <div class="n-set">
        <span class="n-k">{t().language}</span>
        <SegmentedControl<AppLocale>
          ariaLabel={t().language}
          size="sm"
          value={preferences.locale}
          onValueChange={(locale) => preferences.setLocale(locale)}
          options={[
            { value: "de", label: "Deutsch" },
            { value: "en", label: "English" },
          ]}
        />
      </div>
      <div class="n-set">
        <span class="n-k">{t().persist}</span>
        <Switch aria-label={t().persist} value={() => usage()?.persisted ?? false} onValueChange={(next) => void togglePersist(next)} />
        <span class="n-v">{persistDenied() ? t().persistDenied : t().persistHelp}</span>
      </div>
      <div class="n-set">
        <span class="n-k">{t().storage}</span>
        <span class="n-help" style={{ "font-variant-numeric": "tabular-nums" }}>
          {usage() ? formatBytes(usage()?.bytes ?? 0) : "–"}
        </span>
        <ProgressBar
          class="n-meter"
          size="xs"
          label={t().storage}
          value={(() => {
            const current = usage();
            return current?.quota ? (current.bytes / current.quota) * 100 : 0;
          })()}
        />
        <span class="n-v">{t().storageSummary({ notes: usage()?.notes ?? app.records().length, files: usage()?.files ?? 0 })}</span>
      </div>
      <div class="n-set-buttons">
        <Button variant="secondary" onClick={() => void runExport()}>
          <Icon name="ti-download" />
          {t().exportShort}
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            props.close();
            openImport();
          }}
        >
          <Icon name="ti-upload" />
          {t().importShort}
        </Button>
      </div>
      <div class="n-set">
        <button type="button" class="n-textlink" onClick={() => void clearAll()}>
          {t().clearAll}
        </button>
      </div>
      <Show when={app.storeError() === "unavailable"}>
        <p class="n-fine">{t().unavailableBody}</p>
      </Show>
      <div class="n-dialog-acts">
        <Button variant="primary" onClick={() => props.close()}>
          {t().done}
        </Button>
      </div>
    </div>
  );
}

export function openSettings() {
  void prompts.dialog<void>((close) => <SettingsBody close={() => close()} />, { header: false, history: true });
}
