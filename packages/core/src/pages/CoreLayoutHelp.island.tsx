import type { HelpDocumentManifest } from "@k2b/cloud/shared";
import { Layout } from "@k2b/cloud/ssr/islands";

type Props = {
  documents: readonly HelpDocumentManifest[];
  initialTopic?: string;
  pageBase: string;
};

export default function CoreLayoutHelp(props: Props) {
  return <Layout.HelpPage documents={props.documents} initialTopic={props.initialTopic} pageBase={props.pageBase} />;
}
