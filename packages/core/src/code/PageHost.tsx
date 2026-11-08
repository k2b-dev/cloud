import type { CodePageTree } from "@k2b/cloud/code";
import { FeatCodeMark } from "@k2b/cloud/code/ui";
import { i18n } from "@k2b/stdlib";
import { Button } from "@k2b/ui";
import CodePageTreeView from "./PageTree.island";

const provenanceMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      madeWith: "Made with",
      note: "Someone built this page with feat/code. Never enter passwords or recovery codes here.",
    },
    de: {
      madeWith: "Erstellt mit",
      note: "Diese Seite hat jemand mit feat/code gebaut. Gib hier nie Passwörter oder Wiederherstellungscodes ein.",
    },
  },
});

/** The note's id; a document holds one Code page. */
const NOTE_ID = "code-page-provenance-note";

/**
 * Says on every Code page that someone built it with feat/code, whatever the page shows. Core draws it beside the
 * page's tree, never inside it, as server markup without an island: a Code page describes blocks only, so it can
 * neither reach, restyle nor cover this label. A press opens a short note through the browser's own popover, which
 * also works before scripts load. It never names the owner.
 */
function PageProvenance(props: { locale: string }) {
  const t = provenanceMessages.resolve([props.locale]).t;
  return (
    <div class="code-page-provenance" data-code-provenance="">
      <Button
        class="code-page-provenance__label"
        variant="secondary"
        size="sm"
        tooltip={false}
        popovertarget={NOTE_ID}
        aria-describedby={NOTE_ID}
      >
        <span>{t.madeWith}</span> <FeatCodeMark />
        <i class="ti ti-info-circle" aria-hidden="true" />
      </Button>
      <div id={NOTE_ID} popover="auto" role="note" class="code-page-provenance__note">
        {t.note}
      </div>
    </div>
  );
}

/**
 * A Code page as Core hosts it in every layout: the tree, in its own stacking context, and the feat/code label after
 * it. Only the tree is an island; the label stays server markup.
 */
export default function CodePageHost(props: { tree: CodePageTree; codeId: string; csrf: string; locale: string; timeZone: string }) {
  return (
    // The host is the print region, so a printed or saved page keeps its label.
    <div class="code-page-host" data-code-page-host="" data-print-region="">
      <div class="code-page-host__tree" data-code-page-tree="">
        <CodePageTreeView tree={props.tree} codeId={props.codeId} csrf={props.csrf} locale={props.locale} timeZone={props.timeZone} />
      </div>
      <PageProvenance locale={props.locale} />
    </div>
  );
}
