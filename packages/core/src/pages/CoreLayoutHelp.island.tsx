import LayoutHelpPageV2 from "@k2b/cloud/ssr/help-v2/HelpPage";
import type { LayoutHelpPageProps } from "@k2b/cloud/ssr/islands";

/** An app's full-page Help on v2, under Core's `/help/apps/<id>`. */
export default function CoreLayoutHelp(props: Omit<LayoutHelpPageProps, "embedded" | "accent">) {
  return <LayoutHelpPageV2 {...props} />;
}
