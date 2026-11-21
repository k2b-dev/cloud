import { CodeRefusalNotice } from "@k2b/cloud/ssr/code-page/CodeRefusalNotice";
import type { CodePageRefusal } from "@k2b/cloud/ssr/code-page/data";

/** The refused call of an app's Code, the same notice every Code page shows; its handle copies in the browser. */
export default function CodeRefusal(props: {
  refusal: CodePageRefusal;
  account: string;
  handle: string | null;
  editor: boolean;
  cloudAdmin: boolean;
}) {
  return <CodeRefusalNotice {...props} />;
}
