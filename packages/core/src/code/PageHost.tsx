import type { CodePageNode, CodePageTree } from "@k2b/cloud/code";
import PageProvenance from "./PageProvenance.island";
import CodePageTreeView from "./PageTree.island";
import type { CodePageProvenanceSeed } from "./page-provenance-contracts";

/** Fields exist only inside a form, so a form anywhere in the page, sections included, means the page asks for input. */
const hasForm = (nodes: readonly CodePageNode[]): boolean =>
  nodes.some((node) => node.kind === "Form" || (node.kind === "Section" && hasForm(node.children)));

/**
 * A Code page as Core hosts it in every layout: the tree, in its own stacking context, and a footer with the feat/code
 * label after it. Core draws the label beside the tree, never inside it: a Code page describes blocks only, so it can
 * neither reach, restyle nor cover the label. The footer belongs to the page's own scroll area, so the last block
 * always ends above it.
 */
export default function CodePageHost(props: {
  tree: CodePageTree;
  codeId: string;
  csrf: string | null;
  locale: string;
  timeZone: string;
  provenance: CodePageProvenanceSeed;
}) {
  return (
    // The host is the print region, so a printed or saved page keeps its label after the page.
    <div class="code-page-host" data-code-page-host="" data-print-region="">
      <div class="code-page-host__tree" data-code-page-tree="">
        <CodePageTreeView tree={props.tree} codeId={props.codeId} csrf={props.csrf} locale={props.locale} timeZone={props.timeZone} />
      </div>
      <div class="code-page-provenance" data-code-provenance="">
        <PageProvenance provenance={props.provenance} codeId={props.codeId} form={hasForm(props.tree.children)} locale={props.locale} />
      </div>
    </div>
  );
}
