import { CodeNavStatus } from "@k2b/cloud/ssr/code-nav-status";
import CodePage, { type CodePageData } from "@k2b/cloud/ssr/code-page";
import { AppWorkspace } from "@k2b/ui";

/** The island around the shared Code page, and the owner's navigation entry with its warning dot. */
export function StoreCode(props: { code: CodePageData }) {
  return <CodePage data={props.code} />;
}

export function StoreCodeEntry(props: { storeId: string; attention: boolean }) {
  return (
    <AppWorkspace.SidebarItem
      href={`/app/inventory/${props.storeId}/code`}
      icon="ti ti-code"
      meta={<CodeNavStatus attention={props.attention} />}
    >
      Code
    </AppWorkspace.SidebarItem>
  );
}
