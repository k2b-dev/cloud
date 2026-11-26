import { Button, LocaleProvider, MarkdownEditor } from "@k2b/ui";
import { Bar, Canvas, Pane, Text, Workspace } from "@k2b/ui/v2";
import { render } from "solid-js/web";
import { createEditor, Editor, markdownActions, Toolbar } from "./index";

// The two Markdown editors of Cloud inside a v2 screen, as Files, Tools and Notebooks place them: the editor of
// `@k2b/ui` (`MarkdownEditor`, embedded) and the shared editor of `@k2b/editor` with its toolbar, each in a `Canvas`
// below a v2 head. The page loads Cloud's stylesheet (v1 and v2), as every Cloud page does.

const offer = `# Angebot Einbauschrank Flur

Familie Oswald, Lindenweg 4

- Korpus Eiche, geölt
- Schiebetüren mit Spiegel
- **Lieferung** in KW 51`;

const root = document.getElementById("root");
// `data-shell` on the root: the page is the content of a Cloud shell, which is the v2 scope; the editors fill it
const inShell = root?.hasAttribute("data-shell") ?? false;
if (root)
  render(() => {
    const editor = createEditor();
    const actions = markdownActions(editor, "de");
    return (
      <LocaleProvider locale="de">
        {/* `?v1` renders the same page without the v2 scope: the editors as a v1 page shows them */}
        <div
          class={inShell || location.search.includes("v1") ? undefined : "k2-ui"}
          style={inShell ? { display: "flex", flex: "1", "min-height": "0" } : { position: "fixed", inset: "0", display: "flex" }}
        >
          <Workspace head={<Bar start={<Text type="body">Angebot Einbauschrank Flur.md</Text>} />}>
            <Pane.Split>
              <Pane label="Datei" width={{ min: 320, default: 640 }}>
                <Canvas label="Angebot Einbauschrank Flur.md" height={360}>
                  <div data-editor="ui" style={{ height: "100%" }}>
                    <MarkdownEditor
                      aria-label="Angebot Einbauschrank Flur.md"
                      value={offer}
                      fill
                      variant="embedded"
                      onSave={() => undefined}
                      onClose={() => undefined}
                    />
                  </div>
                </Canvas>
              </Pane>
              <Pane label="Notiz">
                <Canvas label="Notiz" height={360}>
                  <div data-editor="shared" style={{ display: "flex", "flex-direction": "column", height: "100%" }}>
                    <Toolbar
                      editor={editor}
                      groups={[
                        { items: [actions.bold, actions.italic, actions.strikethrough, actions.code] },
                        { items: [actions.bulletList, actions.numberedList, actions.quote] },
                        { items: [actions.link, actions.table] },
                      ]}
                      end={
                        // a labelled control of the host, as Notebooks puts its comments there
                        <Button size="xs" variant="ghost" aria-label="2 Kommentare">
                          <i class="ti ti-message-circle" aria-hidden="true" />
                          <span>2</span>
                        </Button>
                      }
                    />
                    {/* the host sets the text on the v2 edge, as a note column does */}
                    <div style={{ padding: "0 var(--k2-edge)", flex: "1", "min-height": "0" }}>
                      <Editor editor={editor} label="Notiz" initialValue={offer} maxLength={10000} toolbar={false} />
                    </div>
                  </div>
                </Canvas>
              </Pane>
            </Pane.Split>
          </Workspace>
        </div>
      </LocaleProvider>
    );
  }, root);
