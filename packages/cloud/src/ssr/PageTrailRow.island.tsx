import { PageTitle, usePageTrail } from "@k2b/ui";
import { Show } from "solid-js";

/**
 * The shell's own place for the way up, above pages without a workspace. It
 * shows only on a page with a page above it, and steps back when the page
 * renders a workspace (whose head shows it) or its own `PageTrail`.
 */
export default function PageTrailRow() {
  const trail = usePageTrail();
  const deep = () => {
    const current = trail();
    return current?.ancestors.length ? current : undefined;
  };
  return (
    <div class="layout-page-head" data-trail={deep() ? "up" : undefined}>
      <Show when={deep()}>{(current) => <PageTitle trail={current()} as="p" fallback />}</Show>
    </div>
  );
}
