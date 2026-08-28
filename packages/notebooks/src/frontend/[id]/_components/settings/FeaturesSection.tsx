import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { CheckboxCard, NoticeCard, prompts, SettingsGroup, useLocale } from "@k2b/ui";
import { createSignal } from "solid-js";
import { apiClient } from "@/api/client";
import type { Notebook } from "../sidebar/types";
import { readSettings, writeSettings } from "./NotebookSettingsStore";
import { SaveStatus, settingsChoiceClass } from "./shared";
import { readErrorMessage } from "./utils";
import { notebookSettingsMessages } from "./messages";

function ViewSection(props: { notebook: Notebook }) {
  const locale = useLocale();
  const t = () => notebookSettingsMessages.resolve([locale()]).t;
  const [mode, setMode] = createSignal(readSettings(props.notebook.id).sidebarMode);

  const selectMode = (next: "simple" | "navigator") => {
    if (next === mode()) return;
    setMode(next);
    writeSettings(props.notebook.id, { sidebarMode: next });
    refreshCurrentPath();
  };

  const handleModeKeyDown = (event: KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    selectMode(event.key === "ArrowLeft" || event.key === "ArrowUp" || event.key === "Home" ? "simple" : "navigator");
  };

  return (
    <div class="grid grid-cols-1 gap-2 md:grid-cols-2" role="radiogroup" aria-label={t().sidebarMode}>
      <button
        type="button"
        role="radio"
        aria-checked={mode() === "simple"}
        tabIndex={mode() === "simple" ? 0 : -1}
        class={settingsChoiceClass(mode() === "simple")}
        onClick={() => selectMode("simple")}
        onKeyDown={handleModeKeyDown}
      >
        <span class="flex items-center gap-2 text-sm font-semibold">
          <i class="ti ti-layout-sidebar" />
          {t().simpleSidebar}
        </span>
        <span class="mt-1 block text-xs text-dimmed">{t().simpleSidebarDescription}</span>
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={mode() === "navigator"}
        tabIndex={mode() === "navigator" ? 0 : -1}
        class={settingsChoiceClass(mode() === "navigator")}
        onClick={() => selectMode("navigator")}
        onKeyDown={handleModeKeyDown}
      >
        <span class="flex items-center gap-2 text-sm font-semibold">
          <i class="ti ti-layout-list" />
          {t().navigator}
        </span>
        <span class="mt-1 block text-xs text-dimmed">{t().navigatorDescription}</span>
      </button>
    </div>
  );
}

export function FeaturesSection(props: { notebook: Notebook; isAdmin: boolean; onNotebookChange: (notebook: Notebook) => void }) {
  const locale = useLocale();
  const t = () => notebookSettingsMessages.resolve([locale()]).t;
  const [enabled, setEnabled] = createSignal(props.notebook.scriptsEnabled);
  const [saved, setSaved] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);

  const mutation = mutations.create<Notebook, boolean>({
    mutation: async (next) => {
      const res = await apiClient[":id"].$patch({
        param: { id: props.notebook.id },
        json: { scriptsEnabled: next },
      });
      if (!res.ok) throw new Error(await readErrorMessage(res, t().scriptingUpdateFailed));
      return (await res.json()) as Notebook;
    },
    onSuccess: (next) => {
      setEnabled(next.scriptsEnabled);
      setSaved(true);
      setError(null);
      props.onNotebookChange(next);
    },
    onError: (err) => {
      setEnabled(props.notebook.scriptsEnabled);
      setSaved(false);
      setError(err.message);
      prompts.error(err.message);
    },
  });

  const setScriptsEnabled = async (next: boolean) => {
    if (next && !enabled()) {
      const confirmed = await prompts.confirm(
        t().scriptingConfirm({ name: props.notebook.name }),
        {
          title: t().enableScripting,
          icon: "ti ti-alert-triangle",
          variant: "danger",
          confirmText: t().enable,
        },
      );
      if (!confirmed) return;
    }
    setEnabled(next);
    setSaved(false);
    setError(null);
    mutation.mutate(next);
  };

  return (
    <>
      <SettingsGroup title={t().yourView} description={t().yourViewDescription}>
        <ViewSection notebook={props.notebook} />
        <SaveStatus loading={false} saved error={null} label={t().savedBrowser} />
      </SettingsGroup>

      <SettingsGroup title={t().notebookBehavior} description={t().notebookBehaviorDescription}>
        <CheckboxCard
          label={t().enableScripts}
          description={t().enableScriptsDescription}
          icon="ti ti-code"
          value={enabled}
          onValueChange={setScriptsEnabled}
          disabled={!props.isAdmin || mutation.loading()}
        />
        <NoticeCard tone="warning" icon={false} bodyClass="flex items-start gap-2">
          <i class="ti ti-alert-triangle mt-0.5 shrink-0" />
          <span>
            {t().scriptWarning}
          </span>
        </NoticeCard>
        <SaveStatus loading={mutation.loading()} saved={saved()} error={error()} />
      </SettingsGroup>
    </>
  );
}
