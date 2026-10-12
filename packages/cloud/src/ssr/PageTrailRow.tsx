import { PageTitle, type PageTrailState } from "@k2b/ui";

/**
 * The shell's own place for the way up, above pages without a workspace. It
 * shows only on a page with a page above it, and steps back when the page
 * renders a workspace (whose head shows it) or its own `PageTrail`.
 */
export default function PageTrailRow(props: { trail: PageTrailState }) {
  return (
    <div class="layout-page-head" data-trail={props.trail.ancestors.length ? "up" : "title"}>
      <PageTitle trail={props.trail} as="p" fallback />
    </div>
  );
}
