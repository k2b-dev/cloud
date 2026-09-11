import { CatalogSectionDemo } from "./CatalogSectionDemo";
import demos from "./demo-sections/content";

export default function ContentCatalogDemo(props: { slug: string; search?: string }) {
  return <CatalogSectionDemo demos={demos} slug={props.slug} search={props.search} />;
}
