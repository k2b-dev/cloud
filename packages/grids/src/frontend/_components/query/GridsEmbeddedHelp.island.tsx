import type { HelpDocumentManifest } from "@k2b/cloud/shared";
import { Layout } from "@k2b/cloud/ssr/islands";

export default function GridsEmbeddedHelp(props: { documents: readonly HelpDocumentManifest[]; initialTopic?: string }) {
  return <Layout.HelpPage documents={props.documents} initialTopic={props.initialTopic} includeShortcuts={false} embedded />;
}
