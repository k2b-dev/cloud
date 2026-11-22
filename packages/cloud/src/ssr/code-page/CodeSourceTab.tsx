import { type DateContext, dates } from "@k2b/stdlib";
import { ButtonLink, Paper, Placeholder, Select, useLocale } from "@k2b/ui";
import { CodeDiff, type CodeDiffFile } from "@k2b/ui/code-diff";
import { createMemo, createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { invokeCapabilityWithDataSchema } from "../../capabilities/client";
import type { CodePageInvoke } from "./data";
import {
  type CodeSourceTabInitial,
  type CodeSourceTabReady,
  type CodeSourceTabSelection,
  loadSourceTabInitial,
  loadSourceTabView,
} from "./source-tab-load";
import { sourceTabMessages } from "./source-tab-messages";

/** The browser asks Core with the person's own session, like the rest of the page. */
const browserInvoke: CodePageInvoke = (invocation, schema) => invokeCapabilityWithDataSchema(invocation, schema);
/** The entry for "no comparison"; version IDs are UUIDs and never take this value. */
const NONE = "none";

const sameSelection = (a: CodeSourceTabSelection, b: CodeSourceTabSelection) => a.file === b.file && a.compare === b.compare;
/** A comparison holds every file, so switching files inside it needs no new request. */
const cacheKey = (selection: CodeSourceTabSelection) =>
  selection.compare ? `compare\u0000${selection.compare}` : `file\u0000${selection.file ?? ""}`;
/** The code alone reads as whole code: one number column, no fills. An empty file still shows its one empty line. */
const wholeFile = (path: string, lines: readonly string[]): CodeDiffFile => ({
  path,
  lines: (lines.length > 0 ? lines : [""]).map((text) => ({ kind: "add", text })),
});

/**
 * The Code tab of an automation's own page, for the people who may change it: the code of the version that is switched
 * on, read only, optionally compared with an earlier version. File and comparison live in the address (`?file=` and
 * `?compare=`), so reload and Back return to the same place.
 */
export function CodeSourceTab(props: {
  data: CodeSourceTabInitial;
  codeId: string;
  href: string;
  versionsHref: string;
  /** The page's time zone for submission dates; defaults to UTC. */
  dates?: DateContext;
}): JSX.Element {
  const locale = useLocale();
  const t = createMemo(() => sourceTabMessages.resolve([locale()]).t);
  const [view, setView] = createSignal<CodeSourceTabInitial>(props.data);
  /** The selection the tab is loading, or the one that failed to load. */
  const [pending, setPending] = createSignal<CodeSourceTabSelection | null>(null);
  const [failed, setFailed] = createSignal<CodeSourceTabSelection | null>(null);
  const [announcement, setAnnouncement] = createSignal("");
  const cache = new Map<string, CodeSourceTabReady>();
  let request = 0;
  // A load that finishes after the tab is gone changes nothing.
  onCleanup(() => request++);

  const ready = (): CodeSourceTabReady | null => {
    const current = view();
    return current.state === "ready" ? current : null;
  };
  if (props.data.state === "ready") cache.set(cacheKey(props.data), props.data);
  const selection = (): CodeSourceTabSelection => {
    const current = ready();
    return pending() ?? failed() ?? { file: current?.file ?? null, compare: current?.compare ?? null };
  };

  // The tab's own address: the page with `?tab=code`, plus what the person chose here.
  const writeAddress = (next: CodeSourceTabSelection) => {
    const url = new URL(props.href, window.location.href);
    url.searchParams.set("tab", "code");
    if (next.file) url.searchParams.set("file", next.file);
    else url.searchParams.delete("file");
    if (next.compare) url.searchParams.set("compare", next.compare);
    else url.searchParams.delete("compare");
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  };
  // An old link whose file or version no longer fits opened the code alone; the address now says what is shown.
  onMount(() => {
    const current = ready();
    const url = new URL(window.location.href);
    if (current && (url.searchParams.has("file") || url.searchParams.has("compare"))) writeAddress(current);
  });

  const announce = (shown: CodeSourceTabReady) => {
    const version = shown.versions.find((item) => item.versionId === shown.compare);
    setAnnouncement(
      shown.diff?.kind === "rows" && version
        ? t().announceDiff({ number: version.number, added: shown.diff.added, removed: shown.diff.removed })
        : t().announceCode,
    );
  };

  const show = async (next: CodeSourceTabSelection) => {
    const current = ready();
    if (!current || (sameSelection(next, selection()) && !failed())) return;
    const compareChanged = next.compare !== selection().compare;
    setFailed(null);
    writeAddress(next);
    const cached = cache.get(cacheKey(next));
    if (cached) {
      request++;
      setPending(null);
      const shown = next.compare ? { ...cached, file: next.file ?? cached.file } : cached;
      setView(shown);
      if (compareChanged) announce(shown);
      return;
    }
    const token = ++request;
    setPending(next);
    const result = await loadSourceTabView(browserInvoke, props.codeId, next);
    if (token !== request) return;
    setPending(null);
    if (result.state === "error") {
      setFailed(next);
      return;
    }
    if (result.state === "ready") {
      cache.set(cacheKey(result), result);
      writeAddress(result);
      if (compareChanged) announce(result);
    }
    setView(result);
  };
  const retry = async () => {
    const next = failed() ?? selection();
    const token = ++request;
    setFailed(null);
    setPending(next);
    // Nothing loaded yet: start again from the address, as the server did.
    const result = ready()
      ? await loadSourceTabView(browserInvoke, props.codeId, next)
      : await loadSourceTabInitial(browserInvoke, props.codeId, new URL(window.location.href));
    if (token !== request) return;
    setPending(null);
    if (result.state === "error") return setFailed(next);
    if (result.state === "ready") {
      cache.set(cacheKey(result), result);
      writeAddress(result);
    }
    setView(result);
  };

  /** The comparison on screen, when it belongs to the chosen version. */
  const shownDiff = () => {
    const current = ready();
    return current?.diff && current.compare === selection().compare ? current.diff : null;
  };
  const files = (): CodeDiffFile[] => {
    const current = ready();
    if (!current) return [];
    const diff = shownDiff();
    if (diff?.kind === "rows") return diff.files;
    return current.enabled.files.map((path) =>
      path === current.file && current.lines ? wholeFile(path, current.lines) : { path, lines: [] },
    );
  };
  const comparedVersion = () => ready()?.versions.find((version) => version.versionId === selection().compare) ?? null;
  const rowsDiff = () => {
    const diff = shownDiff();
    return diff?.kind === "rows" && !pending() ? diff : null;
  };
  const regionLabel = () => {
    const version = comparedVersion();
    return version ? t().diffLabel({ number: version.number }) : t().codeLabel;
  };
  const tooLarge = () => shownDiff()?.kind === "too-large" && !pending();
  const status = () => (pending() ? "loading" : failed() || !ready() || tooLarge() ? "error" : undefined);

  const choose = (path: string) => {
    const current = selection();
    void show({ file: path, compare: current.compare });
  };
  const compareWith = (value: string | null) => {
    const current = ready();
    if (!current) return;
    const compare = value && value !== NONE ? value : null;
    // A file that only the earlier version has falls back to the first file of the version that is switched on.
    const file = selection().file;
    void show({ file: compare || (file && current.enabled.files.includes(file)) ? file : (current.enabled.files[0] ?? null), compare });
  };

  const date = (iso: string) => dates.formatDate(iso, { ...props.dates, locale: locale() });
  const options = () => [
    { value: NONE, label: t().compareNone, description: t().compareNoneHint },
    ...(ready()?.versions ?? []).map((version) => ({
      value: version.versionId,
      label: t().compareVersion({ number: version.number }),
      description: t().compareSubmitted({ date: date(version.submittedAt) }),
    })),
  ];
  const onlyOne = () => (ready()?.versions.length ?? 0) === 0;
  const footId = `code-source-foot-${props.codeId}`;

  const toolbar = (
    <>
      <span class="text-[12px] leading-5 text-(--k2b-text-subtle)" aria-hidden="true">
        {t().compareLabel}
      </span>
      <Select
        class="w-36"
        aria-label={t().compareLabel}
        aria-describedby={footId}
        value={selection().compare ?? NONE}
        options={options()}
        disabled={onlyOne() || !ready()}
        onValueChange={compareWith}
      />
      <Show when={selection().compare}>
        <span class="min-w-[3.5rem] font-mono text-[12px] tabular-nums leading-5">
          <Show when={rowsDiff()}>
            {(diff) => (
              <>
                <span aria-hidden="true">
                  <span class="text-(--k2b-success-text)">+{diff().added}</span>{" "}
                  <span class="text-(--k2b-danger-text)">−{diff().removed}</span>
                </span>
                <span class="sr-only">{t().stat({ added: diff().added, removed: diff().removed })}</span>
              </>
            )}
          </Show>
        </span>
      </Show>
      <i class="ti ti-file-code text-[15px] text-(--k2b-text-subtle)" aria-hidden="true" />
    </>
  );

  const foot = () => {
    const version = comparedVersion();
    if (onlyOne() && ready()) return t().footOne;
    if (version && ready()) return t().footDiff({ number: version.number });
    return null;
  };

  return (
    <Show
      when={view().state !== "none"}
      fallback={
        <Placeholder
          state="empty"
          icon="ti ti-code"
          title={t().noneTitle}
          description={t().noneText}
          action={
            <ButtonLink href={props.versionsHref} size="sm" variant="secondary">
              {t().noneAction}
            </ButtonLink>
          }
        />
      }
    >
      <Paper as="section" aria-label={t().fieldLabel} class="flex min-w-0 flex-col gap-2.5 md:px-4 pt-3 pb-3 max-md:px-3">
        {/* The one place outside the admin review where source shows; the no-source check skips exactly this region. */}
        <div class="min-w-0" data-code-source-region="code-tab">
          <CodeDiff
            class="md:[--k2b-code-diff-height:35rem] max-md:[--k2b-code-diff-height:26.25rem]"
            files={files()}
            file={selection().file ?? undefined}
            onFileChange={choose}
            status={status()}
            errorDescription={tooLarge() ? t().tooLarge : t().error}
            onRetry={tooLarge() ? undefined : () => void retry()}
            label={regionLabel()}
            toolbarStart={toolbar}
          />
        </div>
        <p id={footId} class="m-0 flex items-start gap-1.5 text-[12px] leading-5 text-(--k2b-text-subtle)">
          <i class="ti ti-lock mt-[3px] text-[13px]" aria-hidden="true" />
          <Show
            when={foot()}
            fallback={
              <span>
                {t().footCode} <code class="rounded bg-(--k2b-surface-muted) px-1 font-mono text-[12px]">cld code pull</code>.
              </span>
            }
          >
            {(text) => <span>{text()}</span>}
          </Show>
        </p>
        <p class="sr-only" role="status" aria-live="polite">
          {announcement()}
        </p>
      </Paper>
    </Show>
  );
}

export default CodeSourceTab;
