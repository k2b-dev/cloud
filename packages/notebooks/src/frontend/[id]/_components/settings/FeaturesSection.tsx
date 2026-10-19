import { mutation as mutations } from "@k2b/stdlib/solid";
import { Select, SettingsField, SettingsGroup, Switch, useLocale, watchAppHostWidth } from "@k2b/ui";
import { createSignal, onCleanup, Show } from "solid-js";
import { isServer } from "solid-js/web";
import { apiClient } from "@/api/client";
import { isPresentationMode, type PresentationMode } from "@/lib/presentation-mode";
import { TAB_KEY_PREFERENCE_EVENT } from "../detail/events";
import { changeFullWidth, createFullWidth } from "../full-width";
import type { Notebook } from "../sidebar/types";
import { notebookSettingsMessages } from "./messages";
import { readFullWidth, readTabMovesFocus, setTabMovesFocus } from "./NotebookSettingsStore";
import { SaveStatus } from "./shared";
import { readErrorMessage } from "./utils";

/**
 * Personal preferences stored in this browser; an open note applies them without a reload. `host` returns an element
 * inside the app: the dialog mounts outside the app's host, so CSS here cannot query it. Below a 64 rem host "Full width"
 * changes nothing (app.css), so the switch stays away, as the View menu choice and the command do.
 */
function PersonalViewSection(props: { host: () => Element }) {
  const locale = useLocale();
  const t = () => notebookSettingsMessages.resolve([locale()]).t;
  const fullWidth = createFullWidth(readFullWidth());
  const [wide, setWide] = createSignal(false);
  // Measures before the first render, so the dialog opens in its final layout.
  if (!isServer) onCleanup(watchAppHostWidth(props.host(), 64, setWide));
  const [tabMovesFocus, setTabMovesFocusValue] = createSignal(readTabMovesFocus());

  const change = (next: boolean) => {
    setTabMovesFocusValue(next);
    setTabMovesFocus(next);
    window.dispatchEvent(new Event(TAB_KEY_PREFERENCE_EVENT));
  };

  return (
    <SettingsGroup title={t().onlyForYou} description={t().yourViewDescription}>
      <Show when={wide()}>
        <Switch
          class="notebooks-full-width-option"
          label={t().fullWidth}
          description={t().fullWidthDescription}
          value={fullWidth}
          onValueChange={changeFullWidth}
        />
      </Show>
      <Switch label={t().tabMovesFocus} description={t().tabMovesFocusDescription} value={tabMovesFocus} onValueChange={change} />
      <SaveStatus loading={false} saved error={null} label={t().savedBrowser} />
    </SettingsGroup>
  );
}

export function DefaultPresentationSection(props: {
  notebook: Notebook;
  isAdmin: boolean;
  onNotebookChange: (notebook: Notebook) => void;
}) {
  const locale = useLocale();
  const t = () => notebookSettingsMessages.resolve([locale()]).t;
  const mutation = mutations.create<Notebook, PresentationMode>({
    mutation: async (next, { abortSignal }) => {
      const res = await apiClient[":id"].$patch(
        { param: { id: props.notebook.id }, json: { defaultPresentationMode: next } },
        { init: { signal: abortSignal } },
      );
      if (!res.ok) throw new Error(await readErrorMessage(res, t().updateFailed));
      return res.json();
    },
    onSuccess: (next) => props.onNotebookChange(next),
  });
  onCleanup(mutation.abort);

  return (
    <SettingsGroup title={t().defaultView} description={t().defaultViewDescription}>
      <SettingsField label={t().defaultView} description={t().defaultViewHelp} error={() => undefined}>
        <Select
          aria-label={t().defaultView}
          value={() => props.notebook.defaultPresentationMode}
          onValueChange={(next) => {
            if (props.isAdmin && !mutation.loading() && isPresentationMode(next) && next !== props.notebook.defaultPresentationMode) {
              void mutation.mutate(next);
            }
          }}
          options={[
            { value: "write", label: t().writeView, icon: "ti ti-pencil" },
            { value: "book", label: t().bookView, icon: "ti ti-book" },
            { value: "readonly", label: t().readonlyView, icon: "ti ti-eye" },
          ]}
          searchable={false}
          clearable={false}
          disabled={!props.isAdmin || mutation.loading()}
        />
      </SettingsField>
      <SaveStatus loading={mutation.loading()} saved={!mutation.error()} error={mutation.error()?.message ?? null} />
    </SettingsGroup>
  );
}

export function FeaturesSection(props: {
  notebook: Notebook;
  isAdmin: boolean;
  onNotebookChange: (notebook: Notebook) => void;
  host: () => Element;
}) {
  return (
    <>
      <DefaultPresentationSection notebook={props.notebook} isAdmin={props.isAdmin} onNotebookChange={props.onNotebookChange} />
      <PersonalViewSection host={props.host} />
    </>
  );
}
