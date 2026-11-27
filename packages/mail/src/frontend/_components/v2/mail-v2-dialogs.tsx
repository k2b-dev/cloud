import { i18n } from "@k2b/stdlib";
import { LocaleProvider } from "@k2b/ui";
import { Button, Dialog, Field, Input, Lookup, type LookupLoad, Text } from "@k2b/ui/v2";
import { createSignal, type JSX } from "solid-js";
import { render } from "solid-js/web";

/** The words of Mail's v2 dialogs that no Mail catalog already has. Provisional with the pilot. */
export const mailV2DialogMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: { understood: "OK" },
    de: { understood: "Verstanden" },
  },
});

/**
 * Opens a v2 dialog from code that asks (a deed of a menu, a shared Mail module) and resolves with its answer, `null`
 * when it was closed without one. The dialog stands at the end of the page in a v2 scope and the reader's locale, as
 * `confirm` of `@k2b/ui/v2` does; it leaves the page once answered.
 */
export const openMailV2Dialog = <T,>(locale: string, view: (answer: (value: T | null) => void) => JSX.Element): Promise<T | null> =>
  new Promise((resolve) => {
    const host = document.createElement("div");
    host.className = "k2-ui";
    host.style.display = "contents";
    document.body.append(host);
    let answered = false;
    let stop = () => {};
    const answer = (value: T | null) => {
      if (answered) return;
      answered = true;
      resolve(value);
      // the answer comes from inside the dialog: it leaves the page once that event is done
      queueMicrotask(() => {
        stop();
        host.remove();
      });
    };
    stop = render(() => <LocaleProvider locale={locale}>{view(answer)}</LocaleProvider>, host);
  });

/**
 * A dialog that closes with its answer: open from the start, closed by Escape, its × or a press outside as `null`.
 * While `busy` (a save runs), every way to close waits: the dialog stays until the save has answered.
 */
const Asking = <T,>(props: {
  title: string;
  answer: (value: T | null) => void;
  foot: JSX.Element;
  children: JSX.Element;
  busy?: () => boolean;
}) => {
  const [open, setOpen] = createSignal(true);
  return (
    <Dialog
      title={props.title}
      open={open()}
      onOpenChange={(next) => {
        // the open state is held here: a close asked for while a save runs is not taken
        if (!next && props.busy?.()) return;
        setOpen(next);
        if (!next) props.answer(null);
      }}
      foot={props.foot}
    >
      {props.children}
    </Dialog>
  );
};

/**
 * The conversation's summary in a text of several lines ("" removes it). Saving keeps the dialog open until `save`
 * succeeds: a refusal of the server (too long, changed meanwhile) stands at the field, and the text stays to change.
 * While a save runs, the field is locked (what is stored is what it shows) and the dialog waits for the answer.
 */
export const askMailV2Summary = (
  locale: string,
  text: { title: string; label: string; hint: string; confirm: string; cancel: string },
  value: string,
  save: (typed: string) => Promise<string | null>,
): Promise<true | null> =>
  openMailV2Dialog<true>(locale, (answer) => {
    const [summary, setSummary] = createSignal(value);
    const [error, setError] = createSignal<string>();
    const [busy, setBusy] = createSignal(false);
    let field: HTMLInputElement | HTMLTextAreaElement | undefined;
    const submit = async () => {
      if (busy()) return;
      setBusy(true);
      setError(undefined);
      const refused = await save(summary()).finally(() => setBusy(false));
      if (!refused) return answer(true);
      setError(refused);
      // the field was locked while saving, and Safari then leaves the focus on the page: it goes back to the text
      requestAnimationFrame(() => field?.focus());
    };
    return (
      <Asking
        title={text.title}
        answer={answer}
        busy={busy}
        foot={
          <>
            <Button disabled={busy()} onClick={() => answer(null)}>
              {text.cancel}
            </Button>
            <Button variant="primary" busy={busy()} onClick={() => void submit()}>
              {text.confirm}
            </Button>
          </>
        }
      >
        <Field label={text.label} hint={text.hint} {...(error() ? { error: error() } : {})}>
          <Input
            multiline
            value={summary()}
            onInput={setSummary}
            disabled={busy()}
            ref={(element) => {
              field = element;
            }}
          />
        </Field>
      </Asking>
    );
  });

/**
 * One item to link from a search that loads (a task or an event of Spaces): the v2 lookup, of which the latest tick
 * counts, and "Verknüpfen" to link it.
 */
export const pickMailV2Item = (
  locale: string,
  text: { title: string; label: string; confirm: string; cancel: string },
  load: LookupLoad,
): Promise<string | null> =>
  openMailV2Dialog<string>(locale, (answer) => {
    const [chosen, setChosen] = createSignal<string[]>([]);
    return (
      <Asking
        title={text.title}
        answer={answer}
        foot={
          <>
            <Button onClick={() => answer(null)}>{text.cancel}</Button>
            <Button variant="primary" disabled={chosen().length === 0} onClick={() => answer(chosen()[0] ?? null)}>
              {text.confirm}
            </Button>
          </>
        }
      >
        <Lookup label={text.label} value={chosen()} onChange={(value) => setChosen(value.slice(-1))} load={load} />
      </Asking>
    );
  });

/** Something the person can only read (why the mailbox cannot send), with one button that closes it. */
export const tellMailV2 = (locale: string, title: string, detail: string): Promise<null> =>
  openMailV2Dialog<never>(locale, (answer) => (
    <Asking
      title={title}
      answer={answer}
      foot={
        <Button variant="primary" onClick={() => answer(null)}>
          {mailV2DialogMessages.resolve([locale]).t.understood}
        </Button>
      }
    >
      <Text>{detail}</Text>
    </Asking>
  )).then(() => null);
