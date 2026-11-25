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

/** A dialog that closes with its answer: open from the start, closed by Escape, its × or a press outside as `null`. */
const Asking = <T,>(props: { title: string; answer: (value: T | null) => void; foot: JSX.Element; children: JSX.Element }) => {
  const [open, setOpen] = createSignal(true);
  return (
    <Dialog
      title={props.title}
      open={open()}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) props.answer(null);
      }}
      foot={props.foot}
    >
      {props.children}
    </Dialog>
  );
};

/** The conversation's summary in a text of several lines; "" removes it. */
export const askMailV2Summary = (
  locale: string,
  text: { title: string; label: string; hint: string; confirm: string; cancel: string },
  value: string,
): Promise<string | null> =>
  openMailV2Dialog<string>(locale, (answer) => {
    const [summary, setSummary] = createSignal(value);
    return (
      <Asking
        title={text.title}
        answer={answer}
        foot={
          <>
            <Button onClick={() => answer(null)}>{text.cancel}</Button>
            <Button variant="primary" onClick={() => answer(summary())}>
              {text.confirm}
            </Button>
          </>
        }
      >
        <Field label={text.label} hint={text.hint}>
          <Input multiline value={summary()} onInput={setSummary} />
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
