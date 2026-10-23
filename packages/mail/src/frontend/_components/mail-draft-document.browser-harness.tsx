import { Button, LocaleProvider, TextInput } from "@k2b/ui";
import { createSignal, For, onCleanup } from "solid-js";
import { render } from "solid-js/web";
import type { DraftEditableContent, MailDraft } from "../../contracts";
import MailTextEditor from "./MailTextEditor.client";
import { createMailDraftSession } from "./mail-draft-session";

declare global {
  interface Window {
    mailSharedFixture: {
      content: () => DraftEditableContent;
      state: () => ReturnType<ReturnType<typeof createMailDraftSession>["sharedState"]>;
      unsent: () => boolean;
      savedRevision: () => number | null;
      dispose: () => void;
      remember: (value: boolean) => Promise<void>;
      recover: () => Promise<unknown>;
    };
  }
}

const main = async () => {
  const draft: MailDraft = await (await fetch("/fixture/draft")).json();
  const host = document.getElementById("root");
  if (!host) throw new Error("Missing root");
  let dispose = () => {};
  const App = () => {
    const [content, setContent] = createSignal<DraftEditableContent>(draft);
    const [savedRevision, setSavedRevision] = createSignal<number | null>(null);
    const [saveError, setSaveError] = createSignal("");
    let disposed = false;
    onCleanup(() => {
      disposed = true;
    });
    const session = createMailDraftSession({
      mailboxId: draft.mailboxId,
      currentActor: { kind: "user", id: "Usr001" },
      initialDraft: draft,
      hasVerifiedIdentity: () => true,
      content,
      applyDraftContent: setContent,
      isDisposed: () => disposed,
      onRecovered: () => {},
      onMaterialized: () => {},
      locale: () => "de",
    });
    window.mailSharedFixture = {
      content,
      state: session.sharedState,
      unsent: () => session.shared()?.provider.hasUnsentChanges() ?? false,
      savedRevision,
      dispose: () => dispose(),
      remember: async (value) => {
        await session.shared()?.setRemembering(value);
      },
      recover: async () => session.shared()?.recover(),
    };
    return (
      <LocaleProvider locale="de">
        <div class="flex h-full min-h-0 flex-col">
          <TextInput
            aria-label="Betreff"
            value={() => content().subject}
            onValueChange={(subject) => setContent({ ...content(), subject })}
          />
          <div class="min-h-0 flex-1">
            <For each={[session.shared()]}>
              {(shared) => (
                <MailTextEditor
                  shared={shared ?? undefined}
                  sharedState={session.sharedState}
                  format={() => content().format}
                  body={() => content().body}
                  onBodyInput={(body) => setContent({ ...content(), body })}
                  editable={() => Boolean(session.shared() && !session.sharedState()?.terminal)}
                  completions={() => []}
                  onEditorReady={() => {}}
                />
              )}
            </For>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <Button
              onClick={() => {
                void session.persist().then((saved) => {
                  if (saved) {
                    setSavedRevision(saved.revision);
                    setSaveError("");
                  } else setSaveError(session.statusMessage());
                });
              }}
            >
              Speichern
            </Button>
            <span data-save-error>{saveError()}</span>
            <span data-revision>{savedRevision()}</span>
          </div>
        </div>
      </LocaleProvider>
    );
  };
  dispose = render(App, host);
};
void main();
