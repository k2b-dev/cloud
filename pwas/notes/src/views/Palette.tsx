import { Button, IconButton, prompts } from "@k2b/ui";
import { fuzzy } from "@k2b/stdlib";
import { createMemo, createResource, createSignal, For, type JSX, onMount, Show } from "solid-js";
import * as Y from "yjs";
import { NOTE_TEXT, type NoteRecord } from "../lib/model";
import { type Ranges, search } from "../lib/search";
import { navigate } from "../router";
import { app, t } from "../state";
import { Icon, type IconName, tagColor, when } from "../ui/common";
import { runExport } from "./menus";
import { openSettings } from "./Settings";

type Row = { key: string; icon: IconName; main: JSX.Element; sub?: string; run: () => void };
type Group = { label: string; rows: Row[] };

const textCache = new Map<string, { updatedAt: number; text: string }>();

async function loadTexts(records: NoteRecord[]): Promise<{ record: NoteRecord; text: string }[]> {
  const store = app.store();
  if (!store) return [];
  return Promise.all(
    records.map(async (record) => {
      const cached = textCache.get(record.id);
      if (cached && cached.updatedAt === record.updatedAt) return { record, text: cached.text };
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, await store.encodeState(record.id));
        const text = doc.getText(NOTE_TEXT).toString();
        textCache.set(record.id, { updatedAt: record.updatedAt, text });
        return { record, text };
      } catch {
        return { record, text: "" };
      } finally {
        doc.destroy();
      }
    }),
  );
}

function Marked(props: { text: string; ranges: Ranges }) {
  return (
    <For each={fuzzy.segments(props.text, props.ranges.map(([start, end]) => [start, end] as [number, number]))}>
      {(segment) => (segment.match ? <mark>{segment.text}</mark> : segment.text)}
    </For>
  );
}

function PaletteBody(props: { close: () => void; initialTag?: (tag: string) => void }) {
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(0);
  const [texts] = createResource(() => app.records(), loadTexts, { initialValue: [] });
  let input: HTMLInputElement | undefined;
  onMount(() => input?.focus());

  const go = (fn: () => void) => () => {
    props.close();
    fn();
  };
  const titleOf = (id: string) => app.records().find((record) => record.id === id)?.meta.title || t().untitled;

  const groups = createMemo<Group[]>(() => {
    const q = query().trim();
    if (!q) {
      const recent = [...app.records()].sort((a, b) => b.openedAt - a.openedAt).slice(0, 3);
      const start: Group[] = [
        {
          label: t().recent,
          rows: recent.map((record) => ({
            key: `r-${record.id}`,
            icon: "ti-file-text",
            main: <b>{record.meta.title || t().untitled}</b>,
            sub: when(record.openedAt || record.updatedAt),
            run: go(() => navigate(`/n/${record.id}`)),
          })),
        },
        {
          label: t().actions,
          rows: [
            { key: "a-new", icon: "ti-plus", main: t().newNote, run: go(() => void app.createNote()) },
            { key: "a-export", icon: "ti-download", main: t().exportAll, run: go(() => void runExport()) },
            { key: "a-settings", icon: "ti-settings", main: t().settings, run: go(() => openSettings()) },
          ],
        },
      ];
      return start.filter((group) => group.rows.length > 0);
    }
    const result = search(q, texts());
    const list: Group[] = [];
    if (result.notes.length)
      list.push({
        label: t().groupNotes,
        rows: result.notes.map((hit) => ({
          key: `n-${hit.noteId}`,
          icon: hit.record.share ? "ti-link" : "ti-file-text",
          main: (
            <b>
              <Marked text={hit.title} ranges={hit.ranges} />
            </b>
          ),
          sub: [hit.record.meta.tags.map((tag) => `#${tag}`).join(" "), when(hit.record.updatedAt)].filter(Boolean).join(" · "),
          run: go(() => navigate(`/n/${hit.noteId}`)),
        })),
      });
    if (result.text.length)
      list.push({
        label: t().groupText,
        rows: result.text.map((hit, index) => ({
          key: `t-${hit.noteId}-${index}`,
          icon: "ti-align-left",
          main: <Marked text={hit.line} ranges={hit.ranges} />,
          sub: titleOf(hit.noteId),
          run: go(() => navigate(`/n/${hit.noteId}`)),
        })),
      });
    if (result.headings.length)
      list.push({
        label: t().groupHeadings,
        rows: result.headings.map((hit, index) => ({
          key: `h-${hit.noteId}-${index}`,
          icon: "ti-heading",
          main: <Marked text={hit.heading} ranges={hit.ranges} />,
          sub: titleOf(hit.noteId),
          run: go(() => navigate(`/n/${hit.noteId}`)),
        })),
      });
    if (result.tags.length)
      list.push({
        label: t().groupTags,
        rows: result.tags.map((hit) => ({
          key: `g-${hit.tag}`,
          icon: "ti-hash",
          main: (
            <span style={{ color: tagColor(hit.tag) }}>
              #<Marked text={hit.tag} ranges={hit.ranges} />
            </span>
          ),
          sub: t().tagNotes({ count: hit.count }),
          run: go(() => navigate(`/?tag=${encodeURIComponent(hit.tag)}`)),
        })),
      });
    return list;
  });
  const rows = createMemo(() => groups().flatMap((group) => group.rows));

  const onKey = (event: KeyboardEvent) => {
    const count = rows().length;
    if (event.key === "ArrowDown" && count) {
      event.preventDefault();
      setActive((active() + 1) % count);
    } else if (event.key === "ArrowUp" && count) {
      event.preventDefault();
      setActive((active() - 1 + count) % count);
    } else if (event.key === "Enter") {
      event.preventDefault();
      rows()[active()]?.run();
    }
  };
  let body: HTMLDivElement | undefined;
  const scrollActive = () => body?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });

  return (
    <div class="n-pal" role="dialog" aria-modal="true" aria-label={t().searchEverywhere}>
      <div class="n-pal-in">
        <Icon name="ti-search" />
        <input
          ref={input}
          value={query()}
          placeholder={t().palettePlaceholder}
          aria-label={t().paletteTerm}
          role="combobox"
          aria-expanded="true"
          aria-controls="n-pal-list"
          aria-activedescendant={rows()[active()] ? `n-pal-${rows()[active()]?.key}` : undefined}
          autocomplete="off"
          spellcheck={false}
          onInput={(event) => {
            setQuery(event.currentTarget.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            onKey(event);
            queueMicrotask(scrollActive);
          }}
        />
        <IconButton variant="ghost" label={t().close} onClick={() => props.close()}>
          <Icon name="ti-x" />
        </IconButton>
      </div>
      <div class="n-pal-body" id="n-pal-list" role="listbox" aria-label={t().searchEverywhere} ref={body}>
        <Show
          when={rows().length > 0}
          fallback={
            <div class="n-pal-empty">
              <b>{t().paletteEmptyTitle({ query: query().trim() })}</b>
              {t().paletteEmptyBody}
              <div>
                <Button variant="secondary" onClick={go(() => void app.createNote(`# ${query().trim()}\n\n`))}>
                  <Icon name="ti-plus" />
                  {t().createNamed({ title: query().trim() })}
                </Button>
              </div>
            </div>
          }
        >
          <For each={groups()}>
            {(group) => (
              <div role="group" aria-label={group.label}>
                <div class="n-pal-g" aria-hidden="true">
                  {group.label}
                </div>
                <For each={group.rows}>
                  {(row) => (
                    <button
                      type="button"
                      tabIndex={-1}
                      class="n-pal-r"
                      id={`n-pal-${row.key}`}
                      role="option"
                      aria-selected={rows()[active()]?.key === row.key}
                      onPointerMove={() => setActive(rows().findIndex((entry) => entry.key === row.key))}
                      onClick={() => row.run()}
                    >
                      <Icon name={row.icon} />
                      <span class="n-m">
                        {row.main}
                        <Show when={row.sub}>
                          <small>{row.sub}</small>
                        </Show>
                      </span>
                      <span class="n-ret">↵ {t().open}</span>
                    </button>
                  )}
                </For>
              </div>
            )}
          </For>
        </Show>
      </div>
      <div class="n-pal-foot" aria-hidden="true">
        <span>
          <kbd class="k2b-kbd">↑</kbd>
          <kbd class="k2b-kbd">↓</kbd> {t().choose}
        </span>
        <span>
          <kbd class="k2b-kbd">↵</kbd> {t().open}
        </span>
        <span>
          <kbd class="k2b-kbd">esc</kbd> {t().close}
        </span>
        <span class="n-pal-scope">{t().onlyThisBrowser}</span>
      </div>
    </div>
  );
}

let open = false;
export function openPalette() {
  if (open) return;
  open = true;
  void prompts
    .dialog<void>((close) => <PaletteBody close={() => close()} />, { surface: "bare", header: false, history: true, size: "wide" })
    .finally(() => {
      open = false;
    });
}
