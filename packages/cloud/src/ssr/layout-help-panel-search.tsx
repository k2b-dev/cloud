import { useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { helpMessages } from "./help-messages";
import type { HelpPanelState } from "./layout-help-panel-state";
import { searchHelpTopics } from "./layout-help-search";
import { HelpResultsView } from "./layout-help-views";

export function HelpPanelSearchResults(props: { state: HelpPanelState }) {
  const locale = useLocale();
  const t = () => helpMessages.resolve([locale()]).t;
  const query = createMemo(() => props.state.query().trim().toLocaleLowerCase());
  const [ids, setIds] = createSignal<readonly string[] | null>(null);
  const [searching, setSearching] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [attempt, setAttempt] = createSignal(0);
  let version = 0;
  createEffect(() => {
    const value = query();
    attempt();
    const current = ++version;
    setIds(null);
    setSearching(false);
    setFailed(false);
    const urls = [...new Set(props.state.data.documents.map((topic) => topic.searchUrl))];
    if (!value || !urls.length) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearching(true);
      void Promise.all(
        urls.map(async (url) => {
          const response = await fetch(`${url}?q=${encodeURIComponent(value)}`, {
            signal: controller.signal,
            headers: { Accept: "application/json" },
          });
          if (!response.ok) throw new Error(t().searchFailed);
          const payload: unknown = await response.json();
          return payload && typeof payload === "object" && "ids" in payload && Array.isArray(payload.ids)
            ? payload.ids.filter((id): id is string => typeof id === "string")
            : [];
        }),
      )
        .then((groups) => {
          if (current === version) setIds([...new Set(groups.flat())]);
        })
        .catch((error) => {
          if (!(error instanceof DOMException && error.name === "AbortError") && current === version) setFailed(true);
        })
        .finally(() => {
          if (current === version) setSearching(false);
        });
    }, 120);
    onCleanup(() => {
      clearTimeout(timer);
      controller.abort();
      if (current === version) version++;
    });
  });
  return (
    <Show when={query()}>
      <HelpResultsView
        results={searchHelpTopics(props.state.data.documents, query(), ids())}
        searching={searching()}
        failed={failed()}
        onRetry={() => setAttempt((value) => value + 1)}
        onOpen={() => {}}
      />
    </Show>
  );
}
