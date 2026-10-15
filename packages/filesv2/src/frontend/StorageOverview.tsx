import { openGlobalSearch } from "@k2b/cloud/browser/search";
import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import { AppOverview, AppWorkspace, Button, FileDropTarget, InlineGuidance, LinkCard, useLocale } from "@k2b/ui";
import { For } from "solid-js";
import type { BaseSummary, BasesResult, MarkedEntry } from "../contracts";
import { baseLabel } from "./base-label";
import { useBrowserMessages } from "./browser-messages";
import { DirectoryStatus, IssueMessage } from "./feedback";
import { MarksCatalog } from "./MarksMenu";
import { useFilesMessages } from "./messages";
import { filesUrl } from "./urls";

export default function StorageOverview(props: {
  bases: BaseSummary[];
  issues: BasesResult["issues"];
  onOpenRecent: (entry: MarkedEntry) => void;
  onNavigate: (event: LinkNavigateEvent) => void | Promise<void>;
}) {
  const b = useBrowserMessages();
  const t = useFilesMessages();
  const locale = useLocale();
  return (
    <AppWorkspace.Main scroll class="filesv2-browser">
      {/* Files are uploaded inside a storage location; a file dropped here is refused rather than opened by the browser. */}
      <FileDropTarget label={b().allStorage} disabled onDrop={() => {}} />
      <div class="filesv2-overview">
        <Button
          variant="secondary"
          size="sm"
          class="self-start"
          onClick={() => openGlobalSearch({ query: "", scope: { appId: "filesv2", tag: "file", label: t().files, icon: "ti ti-folders" } })}
        >
          <i class="ti ti-search" aria-hidden="true" />
          {b().searchAllStorage}
        </Button>
        <For each={props.issues}>
          {(issue) => (
            <InlineGuidance tone="info">
              <strong>{t()[issue.area]}: </strong>
              <IssueMessage code={issue.code} />
            </InlineGuidance>
          )}
        </For>
        <nav aria-label={b().allStorage}>
          <AppOverview.Cards>
            <For each={props.bases}>
              {(base) => (
                <LinkCard
                  href={filesUrl(base.id)}
                  navigation="enhanced"
                  onNavigate={props.onNavigate}
                  title={baseLabel(base, b(), locale())}
                  icon={base.kind === "users" ? "ti ti-home" : "ti ti-users"}
                  description={
                    base.kind === "users" ? `${b().onlyYou} · ${base.name} · ${t()[base.area]}` : `${t().group} · ${t()[base.area]}`
                  }
                  meta={base.status !== "existing" ? <DirectoryStatus status={base.status} /> : undefined}
                />
              )}
            </For>
          </AppOverview.Cards>
        </nav>
        <p class="text-xs text-dimmed">{b().createInStorage}</p>
        <section>
          <h2 class="text-sm font-semibold text-primary">{b().recent}</h2>
          <MarksCatalog kind="recent" active onOpen={props.onOpenRecent} />
        </section>
      </div>
    </AppWorkspace.Main>
  );
}
