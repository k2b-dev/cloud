import { LocaleProvider, type PanesLayout } from "@k2b/ui";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import type { ComposeFormattingWarning, ComposePreview } from "../../contracts";
import MailComposerEditor from "./MailComposerEditor";
import MailComposerSignature from "./MailComposerSignature";

export type MailComposerEditorHarnessOptions = { locale: "en" | "de" };

declare global {
  interface Window {
    mountComposerEditor: (options: MailComposerEditorHarnessOptions) => void;
    /** Replaces the preview, as a new compose preview response does. */
    setFormattingWarnings: (warnings: ComposeFormattingWarning[]) => void;
  }
}

const layout: PanesLayout = { version: 2, root: { type: "group", items: ["editor", "preview"], active: "preview" } };
const html =
  '<div style="font-family:Arial;font-size:15px"><p style="margin:0 0 12px">First paragraph of the message.</p><p>Regards</p></div>';

window.mountComposerEditor = (options) => {
  const host = document.getElementById("root");
  if (!host) throw new Error("Missing harness root");
  document.documentElement.lang = options.locale;
  const [preview, setPreview] = createSignal<ComposePreview>({
    html,
    text: "First paragraph of the message.\n\nRegards",
    formattingWarnings: [],
  });
  const [signatureTemplateId, setSignatureTemplateId] = createSignal<string | null>("Sign01");
  const signatures = { templates: [{ id: "Sign01", name: "Support signature" }], personalDefaults: [] };
  window.setFormattingWarnings = (formattingWarnings) => setPreview({ ...preview(), formattingWarnings });
  render(
    () => (
      <LocaleProvider locale={options.locale}>
        <div class="flex min-h-0 w-full flex-1 flex-col">
          <MailComposerEditor
            format={() => "markdown"}
            body={() => 'First paragraph <small>of</small> the <span class="x">message</span>.'}
            onBodyInput={() => undefined}
            editable={() => true}
            completions={() => []}
            panes={() => layout}
            onPanesChange={() => undefined}
            preview={preview}
            previewError={() => undefined}
            previewPending={() => false}
            onRetryPreview={() => undefined}
            onEditorReady={() => undefined}
          />
          <MailComposerSignature
            signatures={signatures}
            value={signatureTemplateId()}
            senderDefaultId="Sign01"
            disabled={false}
            onChange={setSignatureTemplateId}
          />
        </div>
      </LocaleProvider>
    ),
    host,
  );
};
