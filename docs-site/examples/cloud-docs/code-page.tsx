import { FEAT_CODE_NAME, FeatCodeMark } from "@k2b/cloud/code/ui";
import { followCodeRuns } from "@k2b/cloud/ssr/code-live";
import { CodeNavStatus } from "@k2b/cloud/ssr/code-nav-status";
import CodePage, { type CodePageData } from "@k2b/cloud/ssr/code-page";
import { AppWorkspace } from "@k2b/ui";

/** The island around the shared Code page, and the owner's navigation entry with its warning dot. */
export function StoreCode(props: { code: CodePageData }) {
  return <CodePage data={props.code} />;
}

export function StoreCodeEntry(props: { storeId: string; attention: boolean }) {
  return (
    <AppWorkspace.SidebarItem href={`/app/inventory/${props.storeId}/code`} meta={<CodeNavStatus attention={props.attention} />}>
      <AppWorkspace.SidebarItemIcon>
        <FeatCodeMark variant="glyph" tone="current" decorative />
      </AppWorkspace.SidebarItemIcon>
      <AppWorkspace.SidebarItemLabel>Code</AppWorkspace.SidebarItemLabel>
    </AppWorkspace.SidebarItem>
  );
}

/** The head of a Code area and a provenance line, as "Show the feat/code brand" describes. */
export const StoreCodeHead = () => <FeatCodeMark size={30} />;

export const StoreCodeOrigin = (props: { automation: string }) => (
  <p>
    moved by <FeatCodeMark /> “{props.automation}”
  </p>
);

export const storeCodeTitle = `${FEAT_CODE_NAME} · Store`;

/** "Follow run updates": an island outside the Code page follows Core's run hints and reloads its snapshot on a gap. */
export function followStoreRuns(codeId: string, cursor: string | null, animate: (runId: string, state: string) => void) {
  return followCodeRuns(
    codeId,
    (event) => animate(event.runId, event.state),
    async () => {
      location.reload();
    },
    cursor,
  );
}
