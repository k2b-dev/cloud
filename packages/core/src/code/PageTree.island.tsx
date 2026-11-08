import type { CodePageField, CodePageNode, CodePageTree } from "@k2b/cloud/code";
import { codeOwnPath } from "@k2b/cloud/contracts";
import { type DescriptionJson, DescriptionPanel } from "@k2b/cloud/descriptions";
import {
  Button,
  Checkbox,
  DashboardFrame,
  type DashboardFrameState,
  DashboardGrid,
  DashboardSection,
  dialogCore,
  IconButton,
  InlineGuidance,
  LocaleProvider,
  NoticeCard,
  NumberInput,
  PanelDialog,
  QrScanner,
  type QrScannerError,
  Select,
  TextInput,
  type ToastHandle,
  toast,
  useLocale,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import { codePageFailure, codePageMessages } from "./page-messages";
import { type CodePageEventSource, codePageFormBody, requestCodePage } from "./page-request";

/**
 * Draws a checked Code page tree with shared components. Server and first client render show the same page; the
 * browser adds sending without a reload, the camera for scan fields and reloading the tree for followed events.
 * No Code source runs in the browser.
 */
type PageProps = {
  tree: CodePageTree;
  codeId: string;
  csrf: string;
  locale: string;
  /** The reader's time zone, so the server and the browser show the same time. */
  timeZone: string;
  /** Followed events. Without one, a following page loads again when its tab returns. */
  events?: CodePageEventSource;
};
export default function CodePageTreeView(props: PageProps) {
  return (
    <LocaleProvider locale={props.locale}>
      <CodePageContent {...props} />
    </LocaleProvider>
  );
}

type HeadingLevel = 2 | 3 | 4;
const deeper = (level: HeadingLevel): HeadingLevel => (level === 2 ? 3 : 4);
function Title(props: { level: HeadingLevel; id?: string; children: string }) {
  return props.level === 2 ? (
    <h2 id={props.id} class="text-base font-semibold text-primary">
      {props.children}
    </h2>
  ) : props.level === 3 ? (
    <h3 id={props.id} class="text-sm font-semibold text-primary">
      {props.children}
    </h3>
  ) : (
    <h4 id={props.id} class="text-sm font-semibold text-primary">
      {props.children}
    </h4>
  );
}

/** Meaningful colours as text colour, mixed with the text so they stay readable in light and dark. */
const tint = (color: CodePageTree["color"]) =>
  `color-mix(in srgb, var(--color-${color === "zinc" ? "zinc-500" : `${color ?? "blue"}-600`}) 78%, var(--k2b-text))`;

/** Content heights of a panel; panels in one row line up when they share one. */
const heights = { sm: 200, md: 300, lg: 400 } as const;
type Panel = Extract<CodePageNode, { kind: "Chart" | "Table" | "Detail" }>;
const chartHeight = (item: Extract<CodePageNode, { kind: "Chart" }>) => {
  if (item.height) return heights[item.height];
  // Single values and trends need less room than a plot with axes, as in chat charts.
  const kind = item.description?.kind;
  return kind === "sparkline" ? 128 : kind === "stat" ? 160 : kind === "barGauge" ? 192 : heights.md;
};
// A detail row is 2.25 rem high; up to eight rows show without scrolling.
const detailHeight = (item: Extract<CodePageNode, { kind: "Detail" }>) =>
  item.height ? heights[item.height] : `${Math.max(1, Math.min(8, item.items.length)) * 2.25}rem`;

/** Checked page data as JSON: optional fields that are absent leave no key behind. */
const json = (value: unknown): DescriptionJson => {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(json);
  if (typeof value === "object")
    return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => (entry === undefined ? [] : [[key, json(entry)]])));
  return null;
};

/**
 * The portable description of a data block, the same JSON Chat, Pulse and Notebooks draw: Code pages add no drawing
 * of their own. Yes and No are words of the page's language.
 */
function description(item: Panel | Extract<CodePageNode, { kind: "Stats" }>, words: { yes: string; no: string }) {
  switch (item.kind) {
    case "Chart":
      // Without values a chart keeps its frame and title and says why: the description's empty form.
      return item.description ?? { kind: "bar", title: item.title ?? "", empty: item.empty };
    case "Stats":
      return {
        block: "stats",
        items: item.items.map(({ value, ...stat }) => ({ ...stat, value: value ?? "—" })),
      };
    case "Table":
      return {
        block: "table",
        title: item.title,
        ...(item.subtitle ? { subtitle: item.subtitle } : {}),
        ...(item.search ? { search: true } : {}),
        columns: item.columns.map(({ key, ...column }) => {
          // A column without a type that holds only numbers reads as numbers: right-aligned, in the reader's language.
          const values = item.rows.map((row) => row[key]).filter((value) => value !== null && value !== undefined);
          const numeric = column.format !== undefined || (values.length > 0 && values.every((value) => typeof value === "number"));
          return { id: key, ...column, ...(column.type || !numeric ? {} : { type: "number" }) };
        }),
        rows: item.rows,
      };
    case "Detail":
      return {
        block: "details",
        title: item.title,
        items: item.items.map((row) =>
          typeof row.value === "number"
            ? { label: row.label, type: "number", value: row.value, ...(row.format ? { format: row.format } : {}) }
            : {
                label: row.label,
                type: "text",
                value: typeof row.value === "boolean" ? (row.value ? words.yes : words.no) : row.value,
              },
        ),
      };
  }
}

type ScanResult = { text: string } | { error: QrScannerError };

function CodeField(props: { field: CodePageField; changed: () => void }) {
  const locale = useLocale();
  const t = () => codePageMessages.resolve([locale()]).t;
  const common = () => ({ name: props.field.name, label: props.field.label, required: props.field.required, error: props.field.error });
  const field = props.field;
  switch (field.type) {
    case "checkbox": {
      const [value, setValue] = createSignal(field.value === true);
      return (
        <Checkbox
          {...common()}
          value={value}
          onValueChange={(next) => {
            setValue(next);
            props.changed();
          }}
        />
      );
    }
    case "number": {
      const [value, setValue] = createSignal<number | null>(typeof field.value === "number" ? field.value : null);
      return (
        <NumberInput
          {...common()}
          value={value}
          onValueChange={(next) => {
            setValue(next);
            props.changed();
          }}
        />
      );
    }
    case "select": {
      const [value, setValue] = createSignal<string | null>(typeof field.value === "string" ? field.value : null);
      return (
        <Select
          {...common()}
          value={value}
          onValueChange={(next) => {
            setValue(next);
            props.changed();
          }}
          options={field.options ?? []}
        />
      );
    }
    default: {
      const [value, setValue] = createSignal(typeof field.value === "string" ? field.value : "");
      // A camera failure replaces the Code's message until the next page arrives; typing always remains possible.
      const [cameraError, setCameraError] = createSignal<string>();
      let input: HTMLDivElement | undefined;
      const scan = async () => {
        const messages = t();
        const result = await dialogCore.open<ScanResult>(
          (close) => (
            <PanelDialog>
              <PanelDialog.Header title={messages.scanTitle} close={() => close()} closeLabel={messages.closeScanner} />
              <PanelDialog.Body>
                <QrScanner
                  instructions={messages.scanInstructions}
                  onResult={(text) => {
                    close({ text });
                    return true;
                  }}
                  onStop={() => close()}
                  onError={(reason) => close({ error: reason })}
                />
              </PanelDialog.Body>
            </PanelDialog>
          ),
          // Back closes the scanner and stops the camera instead of leaving the page.
          {
            panelClassName: "k2b-dialog k2b-dialog--full",
            contentClassName: "k2b-dialog__viewport",
            ariaLabel: messages.scanTitle,
            history: true,
          },
        );
        if (result && "text" in result) {
          setCameraError(undefined);
          setValue(result.text);
          props.changed();
        } else if (result)
          setCameraError(
            {
              denied: messages.cameraDenied,
              "no-camera": messages.cameraMissing,
              "in-use": messages.cameraInUse,
              unavailable: messages.cameraUnavailable,
            }[result.error],
          );
        input?.querySelector("input")?.focus();
      };
      return (
        <div ref={input} class="min-w-0">
          <TextInput
            {...common()}
            error={() => cameraError() ?? field.error}
            type={field.type === "email" ? "email" : "text"}
            multiline={field.type === "textarea"}
            value={value}
            onValueChange={(next) => {
              setValue(next);
              props.changed();
            }}
            suffix={
              field.type === "scan" ? (
                <IconButton label={t().scan} size="sm" variant="ghost" onClick={() => void scan()}>
                  <i class="ti ti-scan" aria-hidden="true" />
                </IconButton>
              ) : undefined
            }
          />
        </div>
      );
    }
  }
}

function CodePageContent(props: PageProps) {
  const t = () => codePageMessages.resolve([props.locale]).t;
  const [page, setPage] = createSignal({ tree: props.tree, csrf: props.csrf });
  /** The form or action whose POST is under way; one at a time, so nothing is sent twice. */
  const [sending, setSending] = createSignal<object | null>(null);
  const [formFailure, setFormFailure] = createSignal<{ form: object; message: string } | null>(null);
  /** Someone typed since this tree arrived; a followed event then waits instead of replacing their input. */
  const [edited, setEdited] = createSignal(false);
  let waiting: ToastHandle | undefined;
  const [loading, setLoading] = createSignal(false);
  /** A reload failed: every panel keeps its data and says it is not current, with Try again. */
  const [stale, setStale] = createSignal(false);
  const panelState = (): DashboardFrameState => (stale() ? "stale" : "ready");
  const read = (options: Intl.DateTimeFormatOptions) => {
    const asOf = page().tree.asOf;
    return asOf ? new Intl.DateTimeFormat(props.locale, { ...options, timeZone: props.timeZone }).format(new Date(asOf)) : undefined;
  };
  const readDate = () => read({ dateStyle: "medium", timeStyle: "short" });
  const readTime = () => read({ timeStyle: "short" });
  const href = (path: string) => codeOwnPath(props.codeId, path);
  const notices = new Set<ToastHandle>();
  let disposed = false;

  /** The address of the shown tree. Dialogs add history entries at the same address; only a new address loads. */
  let shownAt: string | undefined;
  let main: HTMLElement | undefined;
  let heading: HTMLHeadingElement | undefined;
  /** Finds the control that has focus again in the new tree: the same field or submit button of the same form. */
  const focusKey = (element: Element | null): string | undefined => {
    const form = element instanceof HTMLElement && main?.contains(element) ? element.closest("form") : null;
    const action = form?.getAttribute("action");
    if (!form || !action || !element) return undefined;
    const scope = `form[action="${CSS.escape(action)}"]`;
    const name = element.getAttribute("name") ?? element.closest("[data-code-field]")?.getAttribute("data-code-field");
    if (name) return `${scope} [data-code-field="${CSS.escape(name)}"] :is(input:not([type="hidden"]), textarea, button)`;
    return element.matches('button[type="submit"]') ? `${scope} button[type="submit"]` : undefined;
  };
  /**
   * Shows a tree. Focus goes where the person continues: a new page starts at its heading, a returned form at its
   * first invalid field, otherwise at the control they used; a background load moves focus only back to that control.
   */
  const show = (tree: CodePageTree, csrf: string, url: string | null, mode: "push" | "replace", focus: "submit" | "keep") => {
    const key = focusKey(document.activeElement);
    const previous = page().tree.title;
    setPage({ tree, csrf });
    setStale(false);
    setEdited(false);
    waiting?.dismiss();
    waiting = undefined;
    setFormFailure(null);
    if (document.title.startsWith(previous)) document.title = tree.title + document.title.slice(previous.length);
    const moved = !!url && url !== location.href;
    if (moved) {
      if (mode === "push") history.pushState(null, "", url);
      else history.replaceState(null, "", url);
      shownAt = location.href;
      window.scrollTo(0, 0);
    }
    const again = key ? main?.querySelector<HTMLElement>(key) : null;
    const target = moved
      ? heading
      : focus === "submit"
        ? (main?.querySelector<HTMLElement>('[aria-invalid="true"]') ?? again ?? heading)
        : again;
    target?.focus({ preventScroll: !moved });
  };

  let reloading = false;
  let reloadAgain = false;
  let forceAgain = false;
  /** Someone is typing: new data waits for their choice in a toast, which moves nothing on the page. */
  const offer = () => {
    if (waiting) return;
    waiting = toast(t().newData, { duration: 0, action: { label: t().refresh, onClick: () => void reload(true) } });
    notices.add(waiting);
  };
  /** Counts requests that may replace the tree. An answer applies only while its request is the latest one. */
  let generation = 0;
  /**
   * Loads the current address again. Several events while one load runs end in exactly one more load. `force` comes
   * from the person (Refresh, Back) and replaces their input; an event never does, also when typing began mid-load.
   * An event waits for a running submit, whose answer is the newer page.
   */
  const reload = async (force = false) => {
    if (edited() && !force) return offer();
    if (sending() && !force) return;
    if (reloading) {
      reloadAgain = true;
      forceAgain ||= force;
      return;
    }
    reloading = true;
    setLoading(true);
    try {
      let forced = force;
      do {
        reloadAgain = false;
        const at = location.href;
        const ticket = ++generation;
        const answer = await requestCodePage(at);
        // A submit started meanwhile: its answer is newer than this one.
        if (disposed || ticket !== generation) return;
        // Back or Forward changed the address meanwhile: load the new one instead.
        if (location.href !== at) {
          reloadAgain = true;
          continue;
        }
        if (answer.kind === "navigate") return location.assign(answer.url);
        if (answer.kind === "failed") {
          setStale(true);
          const notice = toast.error(codePageFailure(t(), answer.code, t().refreshFailed), {
            action: {
              label: t().retry,
              onClick: () => {
                notice.dismiss();
                void reload(true);
              },
            },
          });
          notices.add(notice);
          return;
        }
        if (answer.kind === "tree") {
          if (edited() && !forced && !forceAgain) return offer();
          show(answer.tree, answer.csrf, answer.url, "replace", "keep");
        }
        forced = forceAgain;
        forceAgain = false;
      } while (reloadAgain);
    } finally {
      reloading = false;
      setLoading(false);
    }
  };

  const send = async (event: SubmitEvent & { currentTarget: HTMLFormElement }, owner: object, kind: "form" | "action") => {
    event.preventDefault();
    if (sending()) return;
    const form = event.currentTarget;
    const at = location.href;
    const ticket = ++generation;
    setSending(owner);
    setFormFailure(null);
    let answer: Awaited<ReturnType<typeof requestCodePage>>;
    try {
      answer = await requestCodePage(form.action, codePageFormBody(form));
    } finally {
      setSending(null);
    }
    // Back left this page meanwhile: the person is elsewhere now, so the answer is not shown.
    if (disposed || ticket !== generation || location.href !== at) return;
    if (answer.kind === "tree") return show(answer.tree, answer.csrf, answer.url, "push", "submit");
    if (answer.kind === "navigate") return location.assign(answer.url);
    // The Code answered with data: its effect happened, so the page shows the current state.
    if (answer.kind === "done") return void reload(true);
    const message = codePageFailure(t(), answer.code, t().actionFailed);
    // A failed form keeps its input and says why beside its button; a single action reports in a toast. A POST
    // is never retried automatically: the person decides whether to send again.
    if (kind === "form") setFormFailure({ form: owner, message });
    else notices.add(toast.error(message));
  };

  onMount(() => {
    const events = props.events;
    const follow = () => page().tree.follow ?? [];
    createEffect(
      on(
        () => follow().join(" "),
        (key) => {
          if (!key || !events) return;
          onCleanup(events.subscribe(follow(), () => void reload()));
        },
      ),
    );
    // A tab that returns may have missed events, as live subscriptions replay on return.
    let hidden = false;
    const visibility = () => {
      if (document.visibilityState === "hidden") hidden = true;
      else if (hidden) {
        hidden = false;
        if (follow().length > 0) void reload();
      }
    };
    // Back and Forward return to pages that a submit opened without reloading the document.
    shownAt = location.href;
    const returned = () => {
      if (location.href === shownAt) return;
      shownAt = location.href;
      void reload(true);
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("popstate", returned);
    onCleanup(() => {
      disposed = true;
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("popstate", returned);
      for (const notice of notices) notice.dismiss();
    });
  });

  const csrfField = () => <input type="hidden" name="_csrf" value={page().csrf} />;

  const action = (item: Extract<CodePageNode, { kind: "Button" | "Action" }>) => (
    <form action={href(item.action)} method="post" data-code-block={item.kind} onSubmit={(event) => void send(event, item, "action")}>
      {csrfField()}
      <For each={Object.entries(item.values ?? {})}>{([name, value]) => <input type="hidden" name={name} value={value} />}</For>
      <Button type="submit" variant="secondary" loading={sending() === item} loadingLabel={t().sending}>
        {item.label}
      </Button>
    </form>
  );

  const node = (item: CodePageNode, level: HeadingLevel): JSX.Element => {
    switch (item.kind) {
      case "Section": {
        const section = (
          <DashboardSection
            title={item.title}
            icon={item.icon}
            iconColor={item.icon ? tint(item.color) : undefined}
            description={item.description}
            headingLevel={level}
          >
            {cells(item.children, deeper(level))}
          </DashboardSection>
        );
        // A section inside a section takes the whole row of its parent's grid.
        return level > 2 ? <div class="col-span-6 min-w-0">{section}</div> : section;
      }
      case "Text":
        return (
          <p class="col-span-6 max-w-3xl whitespace-pre-wrap text-secondary" data-code-block="Text">
            {item.text}
          </p>
        );
      case "Heading":
        return (
          <div class="col-span-6" data-code-block="Heading">
            <Title level={item.level ?? level}>{item.text}</Title>
          </div>
        );
      case "Stats":
      case "Table":
      case "Detail":
      case "Chart":
        return (
          <DescriptionPanel
            spec={json(description(item, t()))}
            title={
              item.kind === "Chart" ? (item.title ?? item.description?.title ?? "") : item.kind === "Stats" ? page().tree.title : item.title
            }
            width={item.kind === "Stats" ? undefined : (item.width ?? "full")}
            height={
              item.kind === "Chart"
                ? chartHeight(item)
                : item.kind === "Detail"
                  ? detailHeight(item)
                  : item.kind === "Table" && item.height
                    ? heights[item.height]
                    : heights.md
            }
            headingLevel={deeper(level)}
            empty={item.kind === "Table" || item.kind === "Chart" ? item.empty : undefined}
            state={panelState()}
            asOf={readTime()}
            onRetry={() => void reload(true)}
          />
        );
      case "Form":
        return (
          <DashboardFrame title={item.title} headingLevel={deeper(level)} width={item.width ?? "full"}>
            <form
              action={href(item.action)}
              method="post"
              class="grid min-w-0 gap-4"
              data-code-block="Form"
              onSubmit={(event) => void send(event, item, "form")}
            >
              {csrfField()}
              <div class="grid max-w-xl gap-4">
                <For each={item.fields}>
                  {(field) => (
                    <div class="min-w-0" data-code-field={field.name}>
                      <CodeField field={field} changed={() => setEdited(true)} />
                    </div>
                  )}
                </For>
              </div>
              <div class="flex flex-wrap items-center gap-3">
                <Button type="submit" loading={sending() === item} loadingLabel={t().sending}>
                  {item.submit}
                </Button>
                <Show when={formFailure()?.form === item}>
                  <InlineGuidance tone="danger" role="alert">
                    {formFailure()?.message}
                  </InlineGuidance>
                </Show>
              </div>
            </form>
          </DashboardFrame>
        );
      case "Link":
        return (
          <a href={href(item.href)} class="col-span-6 w-fit text-accent underline underline-offset-2" data-code-block="Link">
            {item.label}
          </a>
        );
      case "Button":
      case "Action":
        return action(item);
      case "Notice":
        return (
          <div class="col-span-6" data-code-block="Notice">
            <NoticeCard tone={item.tone} title={item.title} detail={item.text} />
          </div>
        );
    }
  };

  /** Neighbouring buttons share one row that wraps, rather than stacking as separate forms. */
  const cells = (items: readonly CodePageNode[], level: HeadingLevel) => {
    const groups = createMemo(() => {
      const result: (CodePageNode | Extract<CodePageNode, { kind: "Button" | "Action" }>[])[] = [];
      for (const item of items) {
        const last = result.at(-1);
        if (item.kind === "Button" || item.kind === "Action") Array.isArray(last) ? last.push(item) : result.push([item]);
        else result.push(item);
      }
      return result;
    });
    return (
      <For each={groups()}>
        {(group) =>
          Array.isArray(group) ? (
            <div class="col-span-6 flex flex-wrap items-center gap-2" data-code-block="Actions">
              <For each={group}>{action}</For>
            </div>
          ) : (
            node(group, level)
          )
        }
      </For>
    );
  };
  /** Blocks outside a section sit in sections of their own, without a title, so every block is a cell of one grid. */
  const sections = createMemo(() => {
    const result: (Extract<CodePageNode, { kind: "Section" }> | CodePageNode[])[] = [];
    for (const item of page().tree.children) {
      const last = result.at(-1);
      if (item.kind === "Section") result.push(item);
      else if (Array.isArray(last)) last.push(item);
      else result.push([item]);
    }
    return result;
  });

  return (
    <main
      ref={main}
      class="mx-auto grid w-full min-w-0 max-w-6xl gap-8 px-4 py-6 sm:px-8 sm:py-8"
      data-print-region=""
      data-code-page-version={page().tree.version}
      aria-busy={loading() || undefined}
    >
      <header class="flex min-w-0 items-center gap-3">
        <Show when={page().tree.icon}>
          {/* The page's symbol in a soft chip of its colour, as Cloud shows app symbols. */}
          <span
            class="inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-xl"
            style={{
              color: tint(page().tree.color),
              background: `color-mix(in srgb, ${tint(page().tree.color)} 12%, var(--k2b-surface))`,
            }}
            aria-hidden="true"
          >
            <i class={page().tree.icon} />
          </span>
        </Show>
        <div class="min-w-0">
          <Show when={page().tree.eyebrow}>
            <p class="text-xs font-medium text-secondary">{page().tree.eyebrow}</p>
          </Show>
          <h1 ref={heading} tabindex="-1" class="text-2xl font-semibold tracking-tight text-primary outline-none sm:text-[1.75rem]">
            {page().tree.title}
          </h1>
          <Show when={page().tree.subtitle || readDate()}>
            <p class="text-sm text-secondary">
              {[page().tree.subtitle, readDate() ? t().asOf({ time: readDate()! }) : undefined].filter(Boolean).join(" · ")}
            </p>
          </Show>
        </div>
      </header>
      <DashboardGrid>
        <For each={sections()}>
          {(section) =>
            Array.isArray(section) ? (
              <DashboardSection ariaLabel={page().tree.title}>{cells(section, 2)}</DashboardSection>
            ) : (
              node(section, 2)
            )
          }
        </For>
      </DashboardGrid>
    </main>
  );
}
