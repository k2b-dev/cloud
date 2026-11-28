import { CodeRefusalNotice } from "@k2b/cloud/ssr/code-page/CodeRefusalNotice";
import type { CodePageRefusal } from "@k2b/cloud/ssr/code-page/data";

/**
 * The refused call of an app's Code, the same notice every Code page shows, with its links and the handle to copy.
 *
 * k2b-ui gap: the Code page's refusal notice is not on v2 yet (packages/cloud owns it); the v2 detail places this one
 * inside a Canvas, on the text edge.
 */
export function CodeRefusal(props: { refusal: CodePageRefusal; account: string; handle: string | null; editor: boolean }) {
  return (
    <div class="px-5 pb-3 max-sm:px-4">
      <CodeRefusalNotice refusal={props.refusal} account={props.account} handle={props.handle} editor={props.editor} cloudAdmin />
    </div>
  );
}
