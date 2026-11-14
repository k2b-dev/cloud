import CodePage, { type CodePageData } from "@k2b/cloud/ssr/code-page";
import { ScrollArea } from "@k2b/ui";

/** One personal Code on the shared Code page, inside the Assistant's main pane. */
export default function AssistantCodeDetail(props: { data: CodePageData }) {
  return (
    <ScrollArea class="min-h-0 flex-1 p-[var(--ui-space-section)]">
      <CodePage data={props.data} />
    </ScrollArea>
  );
}
