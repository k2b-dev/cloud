import type { DateContext } from "@k2b/stdlib";
import { Section } from "@k2b/ui";
import { Show } from "solid-js";
import type { CodePageReportPage } from "../../../code/page-report-contracts";
import CodePageReportList from "./CodePageReportList.island";
import CodePauseAction from "./CodePauseAction.island";
import { codePageReportMessages } from "./report-messages";

/**
 * Open reports on the pages of one automation, under Administration › Code beside the automation. Shown only while
 * there are some, or when they did not load. Admins resolve each report; "Pause" stops the whole automation.
 */
export default function CodePageReports(props: {
  /** Null when the URL needs none, a page, or the part's failure. */
  reports: CodePageReportPage | "failed" | "missing" | null | undefined;
  code: { id: string; title: string; state: string; activeVersionNumber: number | null };
  locale: string;
  dateConfig: DateContext;
}) {
  const t = () => codePageReportMessages.resolve([props.locale]).t;
  const page = () => (props.reports && typeof props.reports === "object" && props.reports.items.length ? props.reports : null);
  const pausable = () => props.code.activeVersionNumber !== null && (props.code.state === "active" || props.code.state === "paused");
  return (
    <Show when={page() || props.reports === "failed"}>
      <Section
        title={t().title}
        icon="ti ti-flag"
        tone="warning"
        count={page()?.nextCursor ? undefined : page()?.items.length}
        meta={page() ? (page()?.nextCursor ? t().openMore({ n: page()?.items.length ?? 0 }) : t().open) : undefined}
        description={t().description}
        state={props.reports === "failed" ? "error" : "ready"}
        errorMessage={t().failed}
        actions={
          <Show when={pausable()}>
            <CodePauseAction codeId={props.code.id} title={props.code.title} paused={props.code.state === "paused"} />
          </Show>
        }
      >
        <Show when={page()}>
          {(loaded) => (
            <CodePageReportList
              codeId={props.code.id}
              items={loaded().items}
              nextCursor={loaded().nextCursor}
              dateConfig={props.dateConfig}
            />
          )}
        </Show>
      </Section>
    </Show>
  );
}
