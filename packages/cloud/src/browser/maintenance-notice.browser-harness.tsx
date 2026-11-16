import { cookies } from "@k2b/stdlib/browser";
import { Button, LocaleProvider, TextInput } from "@k2b/ui";
import { fromJSON } from "seroval";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { TIMEZONE_COOKIE } from "../shared/time";
import ShellRuntime, { type ShellRuntimeProps } from "../ssr/ShellRuntime.island";

type FixtureData = { reply: string; thread: string; send: string };
const data: FixtureData = JSON.parse(document.querySelector<HTMLScriptElement>("#maintenance-notice-fixture-data")!.textContent!);
const root = document.querySelector<HTMLElement>("#maintenance-notice-fixture")!;
const island = document.querySelector<HTMLElement>('solid-island[data-file="ShellRuntime.island.tsx"]');
if (!island) throw new Error("Layout rendered no ShellRuntime island");

/** A Mail-like reply, as an app writes one: a failed send shows the answer's `message` and keeps the text. */
const Reply = () => {
  const [text, setText] = createSignal(data.reply);
  const [result, setResult] = createSignal("");
  const send = async (event: SubmitEvent) => {
    event.preventDefault();
    setResult("");
    const response = await fetch(data.send, { method: "POST", body: JSON.stringify({ text: text() }) });
    const body: { message?: string } = await response.json().catch(() => ({}));
    setResult(response.ok ? "Gesendet." : (body.message ?? "Senden fehlgeschlagen."));
  };
  return (
    <section data-reply class="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-5 sm:px-6">
      <h2 class="font-semibold text-lg">Hallenbelegung im Dezember</h2>
      <p class="text-dimmed text-sm">Jonas Beispiel · heute 09:41</p>
      <p>Hallo Lea, können wir die Halle am 12.12. schon ab 17 Uhr haben?</p>
      <form data-reply-form class="flex flex-col gap-3" onSubmit={(event) => void send(event)}>
        <TextInput multiline lines={4} label="Antwort" value={text} onValueChange={setText} />
        <div class="flex items-start justify-end gap-3">
          {/* The line keeps its height, so a result moves nothing. */}
          <p data-send-result role="status" class="min-h-5 flex-1 text-dimmed text-sm">
            {result()}
          </p>
          <Button type="submit" variant="primary">
            Senden
          </Button>
        </div>
      </form>
    </section>
  );
};

const locale = document.documentElement.lang;
root.replaceChildren();
render(
  () => (
    <LocaleProvider locale={locale}>
      <Reply />
    </LocaleProvider>
  ),
  root,
);
/** Records where the form sits before any notice, then starts the shell and the app's first read. */
const start = () => {
  // The test compares this box with the form's once the notice shows.
  const box = root.querySelector("[data-reply-form]")!.getBoundingClientRect();
  root.dataset.formBox = JSON.stringify([box.left, box.top, box.width, box.height]);
  // A browser that visited before: without its time zone cookie the shell reloads the page once, and the reload
  // would meet a later scenario step than the first read.
  cookies.writeCookie(TIMEZONE_COOKIE, Intl.DateTimeFormat().resolvedOptions().timeZone);
  // The shell's island with the props Layout rendered for this request, mounted as @k2b/ssr mounts islands.
  const props = fromJSON<ShellRuntimeProps>(JSON.parse(island.dataset.props ?? "{}"));
  island.replaceChildren();
  render(() => <ShellRuntime {...props} />, island);
  // The app reloads its thread, as Mail does when a page opens; during an update or maintenance it waits quietly.
  void fetch(data.thread).then(() => {
    root.dataset.threadLoaded = "true";
  });
  root.dataset.ready = "true";
};
requestAnimationFrame(() => requestAnimationFrame(start));
