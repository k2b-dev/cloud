import { CodeAccountHandle } from "@k2b/cloud/ssr/code-page/CodeAccountHandle";

export default function CodeHandle(props: { handle: string }) {
  return <CodeAccountHandle handle={props.handle} />;
}
