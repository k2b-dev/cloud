import CodePage, { type CodePageData } from "@k2b/cloud/ssr/code-page";

export default function BaseCode(props: { code: CodePageData }) {
  return <CodePage data={props.code} />;
}
