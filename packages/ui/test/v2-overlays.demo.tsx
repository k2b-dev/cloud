import { createSignal, For, Show } from "solid-js";
import { Bar, Button, Dialog, Field, Input, Pane, Section, Select, Text, Workspace } from "../src/v2";

// The v2 dialog in the place the mockup puts it: it asks before something is discarded, opened from a button in the
// head that stays on the phone. `<html data-long>` gives the dialog more content than fits, so it scrolls.
// `__k2Shorten()` takes that content away again, so the open dialog gets shorter. `<html data-two>` puts a second Workspace beside it; `__k2Drop(1 | 2)` takes one away, `__k2Ask()` asks
// `Dialog.confirm` from outside both and writes the answer to `<body data-answer>`. `<html data-opened>` has the dialog
// "Neuer Zugang" open from the start, as a page whose address names the dialog ("…/keys/new").

declare global {
  interface Window {
    __k2Drop?: (which: 1 | 2) => void;
    __k2Ask?: () => void;
    __k2Shorten?: () => void;
    /** Opens the stepwise dialog "Gerät koppeln" (a code, then a short confirmation). */
    __k2Pair?: () => void;
    /** Asks a dangerous question ("Gerät entfernen?") from the page. */
    __k2AskDanger?: () => void;
  }
}

export function Demo() {
  const [first, setFirst] = createSignal(true);
  const [second, setSecond] = createSignal(document.documentElement.dataset.two !== undefined);
  window.__k2Drop = (which) => (which === 1 ? setFirst : setSecond)(false);
  window.__k2Ask = () =>
    void Dialog.confirm({ title: "Weiter?", confirm: "Ja" }).then((answer) => {
      document.body.dataset.answer = String(answer);
    });
  return (
    <>
      <Show when={first()}>
        <Order />
      </Show>
      <Show when={second()}>
        <Workspace>
          <Pane label="Zweite Fläche">
            <Text>Ein zweiter Arbeitsbereich auf derselben Seite.</Text>
          </Pane>
        </Workspace>
      </Show>
    </>
  );
}

function Order() {
  const [open, setOpen] = createSignal(false);
  const [secret, setSecret] = createSignal(document.documentElement.dataset.opened !== undefined);
  const [made, setMade] = createSignal(false);
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
  const [long, setLong] = createSignal(document.documentElement.dataset.long !== undefined);
  window.__k2Shorten = () => setLong(false);
  const [pair, setPair] = createSignal(false);
  const [step, setStep] = createSignal(1);
  window.__k2Pair = () => {
    setStep(1);
    setPair(true);
  };
  window.__k2AskDanger = () =>
    void Dialog.confirm({ title: "Gerät entfernen?", confirm: "Entfernen", danger: true }).then((answer) => {
      document.body.dataset.answer = String(answer);
    });
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
          <Field name="material" label="Material" required>
            <Select options={["Eiche", "Buche", "Kiefer"]} placeholder="Wählen" />
          </Field>
          <Field name="customer" label="Kunde">
            <Input value="Familie Oswald" />
          </Field>
          <Field name="payer" label="Zahler">
            <Select options={["Familie Oswald", "Stadtwerke Auental"]} value="Familie Oswald" />
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
        <For each={long() ? Array.from({ length: 24 }, (_, index) => index + 1) : []}>
          {(line) => <Text>Position {line}: Korpus, Front und Beschläge.</Text>}
        </For>
      </Dialog>
      {/* a secret shown once: a stray press outside must not lose it; title and foot change once it is made */}
      <Dialog
        title={made() ? "Zugang erstellt" : "Neuer Zugang"}
        open={secret()}
        onOpenChange={(next) => {
          setSecret(next);
          if (!next) setMade(false);
        }}
        dismissible={false}
        foot={
          <Show
            when={made()}
            fallback={
              <Button variant="primary" onClick={() => setMade(true)}>
                Anlegen
              </Button>
            }
          >
            <Button
              variant="primary"
              onClick={() => {
                setSecret(false);
                setMade(false);
              }}
            >
              Fertig
            </Button>
          </Show>
        }
      >
        <Text>Der Schlüssel wird nur jetzt gezeigt.</Text>
        <Field name="key" label="Schlüssel">
          <Input value="k2b_live_7Q4mX9" />
        </Field>
      </Dialog>
      {/* steps in one place: the long first step sets the height, the short second keeps it */}
      <Dialog
        title="Gerät koppeln"
        open={pair()}
        onOpenChange={setPair}
        stepwise
        foot={
          <Show when={step() === 1} fallback={<Button onClick={() => setPair(false)}>Fertig</Button>}>
            <Button variant="primary" onClick={() => setStep(2)}>
              Weiter
            </Button>
          </Show>
        }
      >
        <Show when={step() === 1} fallback={<Text>Gekoppelt.</Text>}>
          <Text>Öffne die App auf dem anderen Gerät.</Text>
          <Text>Tippe dort auf „Mit Cloud koppeln“.</Text>
          <Text>Scanne den Code oder gib ihn ein.</Text>
          <Text>Vergleiche dann die Zahlen auf beiden Geräten.</Text>
        </Show>
      </Dialog>
    </Workspace>
  );
}
