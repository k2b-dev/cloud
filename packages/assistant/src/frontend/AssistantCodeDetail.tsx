import CodePage, { type CodePageData } from "@k2b/cloud/ssr/code-page";
import { ButtonLink, ScrollArea, useLocale } from "@k2b/ui";
import { assistantMessages } from "./messages";

/**
 * One personal Code on the shared Code page, inside the Assistant's main pane. The page brings its own words and has
 * no source view of Gustav's own. On a phone the sidebar is out of sight, so a link leads back to the list; wider
 * screens keep the list marked in the sidebar instead.
 */
export default function AssistantCodeDetail(props: { data: CodePageData }) {
  const locale = useLocale();
  const t = () => assistantMessages.resolve([locale()]).t;
  return (
    <ScrollArea class="min-h-0 flex-1 p-[var(--ui-space-section)]">
      <ButtonLink href="/app/assistant?code=1" variant="ghost" size="sm" class="assistant-code-detail__back">
        <i class="ti ti-chevron-left" aria-hidden="true" />
        {t().myCode}
      </ButtonLink>
      <CodePage data={props.data} />
    </ScrollArea>
  );
}
