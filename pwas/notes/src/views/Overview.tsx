import { Button, Dropdown, IconButton } from "@k2b/ui";
import { createMemo, createSignal, For, Index, Match, Show, Switch } from "solid-js";
import { monthStrip } from "../lib/activity";
import type { NoteRecord } from "../lib/model";
import { preferences } from "../prefs";
import { navigate, searchParams } from "../router";
import { app, t } from "../state";
import { Footer, Icon, MiniChart, tagColor, Wordmark, when } from "../ui/common";
import { presence } from "../ui/presence";
import { overviewMenu } from "./menus";
import { openPalette } from "./Palette";
import { openReport } from "./Report";

const VISIBLE_TAGS = 6;

export function TopBarOverview(props: { menuOnly?: boolean }) {
  return (
    <header class="n-topbar">
      <Wordmark />
      <div class="n-spacer" />
      <Show when={!props.menuOnly}>
        <button type="button" class="n-searchbtn" aria-label={t().searchEverywhere} onClick={() => openPalette()}>
          <Icon name="ti-search" />
          <span>{t().search}</span>
          <kbd class="k2b-kbd">⌘</kbd>
          <kbd class="k2b-kbd">K</kbd>
        </button>
        <IconButton class="n-phone-only" variant="ghost" label={t().searchEverywhere} onClick={() => openPalette()}>
          <Icon name="ti-search" />
        </IconButton>
      </Show>
      <Dropdown.Root items={overviewMenu()} align="end" phone="sheet">
        <Dropdown.Trigger iconOnly label={t().moreActions} variant="ghost">
          <Icon name="ti-dots" />
        </Dropdown.Trigger>
      </Dropdown.Root>
      <Show when={!props.menuOnly}>
        <Button class="n-desk-only" variant="primary" onClick={() => void app.createNote()}>
          <Icon name="ti-plus" />
          {t().newNote}
        </Button>
      </Show>
    </header>
  );
}

function Streak() {
  // Recounted whenever a note changes; the count itself lives only in this browser.
  const strip = createMemo(() => {
    app.records();
    return monthStrip(new Date());
  });
  const month = () => new Intl.DateTimeFormat(preferences.locale(), { month: "long" }).format(new Date());
  return (
    <div class="n-streak" title={t().streakHint}>
      <div class="n-streak-cells" aria-hidden="true">
        <For each={strip().days}>{(day) => <i data-level={day.level || undefined} data-today={day.today ? "" : undefined} />}</For>
      </div>
      <small>{t().streakMonth({ month: month(), days: strip().activeDays })}</small>
    </div>
  );
}

function ShareMark(props: { record: NoteRecord }) {
  return (
    <Switch>
      <Match when={props.record.share?.kind === "own"}>
        <Icon name="ti-link" class="n-share-mark" />
        <span class="n-sr">{t().shared}</span>
      </Match>
      <Match when={props.record.share?.kind === "foreign" && props.record.share.role === "edit"}>
        <i class="ti ti-users n-share-mark" title={t().fromLinkEdit} aria-label={t().fromLinkEdit} />
      </Match>
      <Match when={props.record.share?.kind === "foreign"}>
        <i class="ti ti-eye n-share-mark" title={t().fromLinkRead} aria-label={t().fromLinkRead} />
      </Match>
    </Switch>
  );
}

function LiveMark(props: { names: { name: string; color: string }[] }) {
  const first = () => props.names[0];
  return (
    <span class="n-live">
      <span class="n-pulse" style={{ "--c": first()?.color ?? "var(--ink)" }} />
      {props.names.length > 1 ? t().writingNowMany({ count: props.names.length }) : t().writingNow({ name: first()?.name ?? "" })}
      <span class="n-lg">&nbsp;{t().now}</span>
    </span>
  );
}

function Thumb(props: { record: NoteRecord; image: string }) {
  const [url, setUrl] = createSignal<string>();
  void app
    .store()
    ?.getFile(props.record.id, props.image)
    .then((blob) => {
      if (blob) setUrl(URL.createObjectURL(blob));
    });
  return (
    <span class="n-thumb">
      <Show when={url()}>{(src) => <img src={src()} alt="" onLoad={() => URL.revokeObjectURL(src())} />}</Show>
    </span>
  );
}

function NoteCard(props: { record: NoteRecord }) {
  const meta = () => props.record.meta;
  const live = () => presence.of(props.record.id);
  return (
    <a class="n-card" href={`/n/${props.record.id}`}>
      <span class="n-t">{meta().title || t().untitled}</span>
      <span class="n-p">
        <span class="n-ex" data-short={meta().chart || meta().image ? "" : undefined}>
          {meta().excerpt}
        </span>
        <Show when={meta().chart}>{(chart) => <MiniChart chart={chart()} />}</Show>
        <Show when={!meta().chart && meta().image}>{(image) => <Thumb record={props.record} image={image()} />}</Show>
      </span>
      <span class="n-cfoot">
        <For each={meta().tags.slice(0, 3)}>{(tag) => <span class="n-dot" style={{ "--c": tagColor(tag) }} />}</For>
        <span class="n-tagtxt">{meta().tags.map((tag) => `#${tag}`).join(" ")}</span>
        <span class="n-spacer" />
        <Show
          when={live().length > 0}
          fallback={
            <>
              <ShareMark record={props.record} />
              <span class="n-when">{when(props.record.updatedAt)}</span>
            </>
          }
        >
          <LiveMark names={live()} />
        </Show>
      </span>
    </a>
  );
}

function HeroCard(props: { record: NoteRecord }) {
  const meta = () => props.record.meta;
  return (
    <a class="n-card" data-hero="" href={`/n/${props.record.id}`}>
      <span class="n-kick">
        {t().continueWriting} · {when(props.record.updatedAt)}
      </span>
      <span class="n-t">{meta().title || t().untitled}</span>
      <span class="n-p">
        <Show when={meta().tasks.length > 0} fallback={meta().excerpt}>
          <For each={meta().tasks}>
            {(task) => (
              <span class="n-task">
                <Icon name="ti-square" />
                <span>{task.text}</span>
              </span>
            )}
          </For>
        </Show>
      </span>
      <span class="n-cfoot">
        <For each={meta().tags.slice(0, 3)}>{(tag) => <span class="n-dot" style={{ "--c": tagColor(tag) }} />}</For>
        <span class="n-tagtxt">{meta().tags.map((tag) => `#${tag}`).join(" ")}</span>
      </span>
    </a>
  );
}

export function Overview() {
  presence.watch();
  // The tag filter lives in the URL, so reload and Back keep it.
  const tag = () => searchParams().get("tag");
  const setTag = (name: string | null) => navigate(name ? `/?tag=${encodeURIComponent(name)}` : "/", { replace: true });
  const [showAllTags, setShowAllTags] = createSignal(false);
  const records = () => app.records();
  const counts = createMemo(() => {
    const map = new Map<string, number>();
    for (const record of records()) for (const name of record.meta.tags) map.set(name, (map.get(name) ?? 0) + 1);
    return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  });
  const shownTags = () => (showAllTags() ? counts() : counts().slice(0, VISIBLE_TAGS));
  const filtered = createMemo(() => {
    const active = tag();
    return active ? records().filter((record) => record.meta.tags.includes(active)) : records();
  });
  const hero = () => (tag() ? undefined : records()[0]);
  const rest = () => filtered().filter((record) => record !== hero());

  return (
    <div class="n-page">
      <TopBarOverview />
      <main class="n-ov">
        <div class="n-ovhead">
          <div>
            <h1>{t().notes}</h1>
            <p class="n-sub">{app.ready() ? t().notesInBrowser({ count: records().length }) : t().loading}</p>
          </div>
          <Streak />
        </div>
        <div class="n-chips" role="group" aria-label={t().filterByTag}>
          <Show when={counts().length > 0}>
            <button type="button" class="n-chip" aria-pressed={tag() === null} onClick={() => setTag(null)}>
              {t().all} <span class="n-count">{records().length}</span>
            </button>
            <For each={shownTags()}>
              {([name, count]) => (
                <button type="button" class="n-chip" aria-pressed={tag() === name} onClick={() => setTag(tag() === name ? null : name)}>
                  <span class="n-dot" style={{ "--c": tagColor(name) }} />
                  {name} <span class="n-count">{count}</span>
                </button>
              )}
            </For>
            <Show when={!showAllTags() && counts().length > VISIBLE_TAGS}>
              <button type="button" class="n-chip" aria-expanded="false" onClick={() => setShowAllTags(true)}>
                {t().moreTags({ count: counts().length - VISIBLE_TAGS })} <Icon name="ti-chevron-down" />
              </button>
            </Show>
          </Show>
        </div>
        <Show
          when={app.ready()}
          fallback={
            <div class="n-grid" aria-busy="true">
              <Index each={[0, 1, 2, 3]}>{() => <div class="n-card-skeleton" />}</Index>
            </div>
          }
        >
          <Show
            when={filtered().length > 0}
            fallback={
              <div class="n-empty">
                <div class="n-ring">
                  <Icon name="ti-search" />
                </div>
                <h2>{t().noMatchTitle({ query: `#${tag() ?? ""}` })}</h2>
                <p>{t().noMatchBody}</p>
                <div class="n-acts">
                  <Button variant="secondary" onClick={() => setTag(null)}>
                    {t().resetSearch}
                  </Button>
                </div>
              </div>
            }
          >
            <div class="n-grid">
              <Show when={hero()}>{(record) => <HeroCard record={record()} />}</Show>
              <For each={rest()}>{(record) => <NoteCard record={record} />}</For>
            </div>
          </Show>
        </Show>
      </main>
      <Footer onReport={() => openReport()} />
      <button type="button" class="n-fab" aria-label={t().newNote} onClick={() => void app.createNote()}>
        <Icon name="ti-plus" />
      </button>
    </div>
  );
}
