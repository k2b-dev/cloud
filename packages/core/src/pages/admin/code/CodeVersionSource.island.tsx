import { CodeDiff, type CodeDiffFile } from "@k2b/ui";

/** One version's source, read-only: whole files through the shared code view, with its file tabs and line numbers. */
export default function CodeVersionSource(props: { files: CodeDiffFile[]; label: string }) {
  return <CodeDiff files={props.files} label={props.label} />;
}
