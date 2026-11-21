import { LocaleProvider } from "@k2b/ui";
import type { CodeVersionCardEntry } from "../code-version-cards";
import { AssistantLiveProvider, createAssistantLiveHub } from "./assistant-live";
import { AssistantCodeVersionCard } from "./code-version-card-deferred";
import { createCodeVersionCardStore } from "./code-version-card-store";

/** The production deferred card and shared store, also used to check server/browser agreement. */
export function ApprovalSnapshotView(props: { initial: CodeVersionCardEntry[]; locale?: string }) {
  const live = createAssistantLiveHub();
  const store = createCodeVersionCardStore(live, props.initial);
  return (
    <LocaleProvider locale={props.locale ?? "de"}>
      <AssistantLiveProvider value={live}>
        {props.initial.map((entry) => (
          <AssistantCodeVersionCard
            {...entry}
            number={entry.state === "available" ? entry.snapshot.preview.number : 1}
            store={store}
            timeZone="UTC"
          />
        ))}
      </AssistantLiveProvider>
    </LocaleProvider>
  );
}
