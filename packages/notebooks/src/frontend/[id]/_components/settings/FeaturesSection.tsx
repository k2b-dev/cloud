import { mutation as mutations } from "@k2b/stdlib/solid";
import { Select, SettingsField, SettingsGroup, Switch, useLocale } from "@k2b/ui";
import { createSignal, onCleanup } from "solid-js";
import { apiClient } from "@/api/client";
import { isPresentationMode, type PresentationMode } from "@/lib/presentation-mode";
import { TAB_KEY_PREFERENCE_EVENT } from "../detail/events";
import type { Notebook } from "../sidebar/types";
import { notebookSettingsMessages } from "./messages";
import { readTabMovesFocus, setTabMovesFocus } from "./NotebookSettingsStore";
import { SaveStatus } from "./shared";
import { readErrorMessage } from "./utils";

/** Personal Tab key preference; an open note editor applies it without a reload. */
function EditorKeyboardSection() {
  const locale = useLocale();
  const t = () => notebookSettingsMessages.resolve([locale()]).t;
  const [tabMovesFocus, setTabMovesFocusValue] = createSignal(readTabMovesFocus());

  const change = (next: boolean) => {
    setTabMovesFocusValue(next);
    setTabMovesFocus(next);
    window.dispatchEvent(new Event(TAB_KEY_PREFERENCE_EVENT));
  };

  return (
    <SettingsGroup title={t().editor} description={t().yourViewDescription}>
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

export function FeaturesSection(props: { notebook: Notebook; isAdmin: boolean; onNotebookChange: (notebook: Notebook) => void }) {
  return (
    <>
      <DefaultPresentationSection notebook={props.notebook} isAdmin={props.isAdmin} onNotebookChange={props.onNotebookChange} />
      <EditorKeyboardSection />
    </>
  );
}
