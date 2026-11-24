import { createSignal, For } from "solid-js";
import { Bar, Button, Dialog, Field, Input, Pane, Section, Select, Text, Workspace } from "../src/v2";

// The v2 dialog in the place the mockup puts it: it asks before something is discarded, opened from a button in the
// head that stays on the phone. `<html data-long>` gives the dialog more content than fits, so it scrolls.

export function Demo() {
  const [open, setOpen] = createSignal(false);
  const [secret, setSecret] = createSignal(false);
  const [kind, setKind] = createSignal("Neubau");
  const [answer, setAnswer] = createSignal("keine");
  const remove = async () =>
    setAnswer(
      (await Dialog.confirm({
        title: "Auftrag löschen?",
        description: "Der Auftrag und seine Positionen werden gelöscht.",
        confirm: "Löschen",
      }))
        ? "ja"
        : "nein",
    );
  const long = document.documentElement.dataset.long !== undefined;
  return (
    <Workspace
      head={
        <Bar
          start={
            <Text type="row" weight="strong">
              Neuer Auftrag
            </Text>
          }
          end={
            <Button keep onClick={() => setOpen(true)}>
              Abbrechen
            </Button>
          }
        />
      }
    >
      <Pane label="Neuer Auftrag">
        <Section title="Auftrag">
          <Field name="kind" label="Art">
            <Select options={["Neubau", "Reparatur", "Montage"]} value={kind()} onChange={setKind} />
          </Field>
          <Text>Antwort: {answer()}</Text>
          <Bar
            end={
              <>
                <Button onClick={() => setSecret(true)}>Zugang anlegen</Button>
                <Button onClick={remove}>Löschen</Button>
              </>
            }
          />
        </Section>
      </Pane>
      <Dialog
        title="Auftrag verwerfen?"
        open={open()}
        onOpenChange={setOpen}
        foot={
          <>
            <Button onClick={() => setOpen(false)}>Weiter bearbeiten</Button>
            <Button variant="primary" onClick={() => setOpen(false)}>
              Verwerfen
            </Button>
          </>
        }
      >
        <Text>Die Angaben gehen verloren. Ein verworfener Auftrag lässt sich nicht wiederherstellen.</Text>
        <For each={long ? Array.from({ length: 24 }, (_, index) => index + 1) : []}>
          {(line) => <Text>Position {line}: Korpus, Front und Beschläge.</Text>}
        </For>
      </Dialog>
      {/* a secret shown once: a stray press outside must not lose it */}
      <Dialog
        title="Zugang erstellt"
        open={secret()}
        onOpenChange={setSecret}
        dismissible={false}
        foot={
          <Button variant="primary" onClick={() => setSecret(false)}>
            Fertig
          </Button>
        }
      >
        <Text>Der Schlüssel wird nur jetzt gezeigt.</Text>
        <Field name="key" label="Schlüssel">
          <Input value="k2b_live_7Q4mX9" />
        </Field>
      </Dialog>
    </Workspace>
  );
}
