import {
  Button,
  CheckboxCard,
  ChoiceList,
  DashboardFrame,
  DescriptionList,
  NoticeCard,
  ReferenceChip,
  StatusBadge,
  TextInput,
} from "@k2b/ui";
import { createMemo, createSignal, For, type JSX, Match, Show, Switch } from "solid-js";
import { DescriptionPanel } from "../descriptions";
import { blockDataAtPath } from "./bind";
import { BLOCK_PANEL_HEIGHTS, blockChartHeight, blockDescription, blockJson } from "./description";
import { blockWords } from "./messages";
import type { Block } from "./schema";

/**
 * Draws checked, bound blocks with shared components: a capability result in the conversation, the details of an
 * approval, and the search preview. The renderer, never the app, decides depth: frames with a chart or table and cards
 * with an image are islands; key figures, text lists and the options of a choice stay flat. No app code, markup or
 * expression runs here; values come from bound paths.
 */

/** A choice the person can answer once; Cloud owns its state and posts the chosen stable ids. */
export type BlockChoiceState = {
  /** `open` takes a choice; `busy` waits for the turn to end; `answered` and `superseded` are read-only. */
  state: "open" | "busy" | "answered" | "superseded";
  /** The ids chosen, from the stored answer once answered. */
  chosen?: readonly string[];
  /** When it was answered, formatted for the reader. */
  answeredAt?: string;
  submit?: (blockId: string, ids: string[]) => Promise<boolean>;
};

/** The fields of a draft: editable while the card edits, locked while it asks for approval. */
export type BlockDraftState = {
  editable: boolean;
  values: Readonly<Record<string, string>>;
  onChange: (name: string, value: string) => void;
};

export type BlockTreeProps = {
  blocks: readonly Block[];
  /** `result` in the conversation, `review` inside an approval, `preview` in search. */
  host: "result" | "review" | "preview";
  locale: string;
  timeZone: string;
  choice?: BlockChoiceState;
  draft?: BlockDraftState;
};

const text = (value: unknown): string =>
  value === undefined || value === null
    ? ""
    : typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : "";
const at = (item: unknown, path: readonly string[] | undefined): unknown => (path ? blockDataAtPath(item, path) : undefined);
const items = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

/** Cloud's own reference to a file draws through Cloud; other sources are app paths the contract already checked. */
const imageSource = (value: unknown): string | undefined => {
  const source = text(value);
  return source.startsWith("/") && !source.startsWith("//") ? source : undefined;
};

type Leaf<K extends Block["kind"]> = Extract<Block, { kind: K }>;

function DetailBlock(props: { block: Leaf<"Detail">; host: BlockTreeProps["host"]; locale: string }) {
  const words = () => blockWords(props.locale);
  const value = (value: unknown) => (typeof value === "boolean" ? (value ? words().yes : words().no) : text(value));
  const list = () => (
    <DescriptionList
      layout="rows"
      size="sm"
      items={props.block.items.map((row) => ({
        term: row.label,
        description:
          row.type === "status" && typeof row.value === "string" && row.states?.[row.value] ? (
            <StatusBadge tone={row.states[row.value]!.tone} label={row.states[row.value]!.label} variant="dot" />
          ) : (
            <span class="cloud-blocks__value">
              <Show when={row.before !== undefined && row.before !== null}>
                <span class="k2b-sr-only">{words().before}:</span>
                <s class="cloud-blocks__before">{value(row.before)}</s>
                <i class="ti ti-arrow-right" aria-hidden="true" />
              </Show>
              <strong>{value(row.value)}</strong>
            </span>
          ),
      }))}
    />
  );
  // In an approval the details already lie on their own surface; elsewhere a detail block is a framed island.
  return (
    <Show when={props.host !== "review"} fallback={list()}>
      <DashboardFrame title={props.block.title} headingLevel={4}>
        {list()}
      </DashboardFrame>
    </Show>
  );
}

function CardsBlock(props: { block: Leaf<"Cards">; locale: string }) {
  const words = () => blockWords(props.locale);
  const list = createMemo(() => items(props.block.items));
  const media = () => props.block.card.image !== undefined;
  return (
    <section class="cloud-blocks__cards" data-media={media() ? "" : undefined} aria-label={props.block.title}>
      <h4 class="cloud-blocks__title">
        {props.block.title}
        <span class="cloud-blocks__count">{list().length}</span>
      </h4>
      <Show when={list().length > 0} fallback={<p class="cloud-blocks__empty">{props.block.empty ?? words().emptyCards}</p>}>
        <ul class="cloud-blocks__card-list">
          <For each={list()}>
            {(item) => {
              const title = () => text(at(item, props.block.card.title));
              const href = () =>
                imageSource(at(item, props.block.card.href)) ??
                (text(at(item, props.block.card.href)).startsWith("https://") ? text(at(item, props.block.card.href)) : undefined);
              const image = () => imageSource(at(item, props.block.card.image));
              return (
                <li class="cloud-blocks__card" data-island={image() ? "" : undefined}>
                  <Show when={image()}>
                    {(src) => (
                      <img
                        class="cloud-blocks__card-image"
                        src={src()}
                        alt={text(at(item, props.block.card.imageAlt)) || title()}
                        loading="lazy"
                      />
                    )}
                  </Show>
                  <div class="cloud-blocks__card-body">
                    <Show when={items(at(item, props.block.card.badges)).length > 0}>
                      <span class="cloud-blocks__badges">
                        <For each={items(at(item, props.block.card.badges)).slice(0, 3)}>
                          {(badge) => <span class="cloud-blocks__badge">{text(badge)}</span>}
                        </For>
                      </span>
                    </Show>
                    <strong class="cloud-blocks__card-title">{title()}</strong>
                    <Show when={text(at(item, props.block.card.subtitle))}>
                      {(subtitle) => <span class="cloud-blocks__card-subtitle">{subtitle()}</span>}
                    </Show>
                    <Show when={(props.block.card.facts ?? []).length > 0 || at(item, props.block.card.price) !== undefined}>
                      <dl class="cloud-blocks__facts">
                        <For each={props.block.card.facts ?? []}>
                          {(fact) => (
                            <div>
                              <dt>{fact.label}</dt>
                              <dd>{text(at(item, fact.value))}</dd>
                            </div>
                          )}
                        </For>
                        <Show when={text(at(item, props.block.card.price))}>
                          {(price) => (
                            <div>
                              <dd class="cloud-blocks__price">{price()}</dd>
                            </div>
                          )}
                        </Show>
                      </dl>
                    </Show>
                    <Show when={href()}>
                      {(link) => (
                        <a
                          class="cloud-blocks__card-link"
                          href={link()}
                          target={link().startsWith("https://") ? "_blank" : undefined}
                          rel="noopener noreferrer"
                        >
                          {link().startsWith("https://") ? new URL(link()).hostname : title()}
                          <i class="ti ti-arrow-up-right" aria-hidden="true" />
                        </a>
                      )}
                    </Show>
                  </div>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
    </section>
  );
}

function ImageBlock(props: { block: Leaf<"Image"> }) {
  return (
    <Show when={imageSource(props.block.src)}>
      {(src) => (
        <figure class="cloud-blocks__image" style={props.block.ratio ? { "aspect-ratio": String(props.block.ratio) } : undefined}>
          <img src={src()} alt={props.block.alt} loading="lazy" />
          <Show when={props.block.caption}>{(caption) => <figcaption>{caption()}</figcaption>}</Show>
        </figure>
      )}
    </Show>
  );
}

function ChoiceBlock(props: { block: Leaf<"Choice">; locale: string; choice?: BlockChoiceState }) {
  const words = () => blockWords(props.locale);
  const options = createMemo(() =>
    items(props.block.options).map((option) => ({
      id: text(at(option, props.block.option.id)),
      title: text(at(option, props.block.option.title)),
      subtitle: text(at(option, props.block.option.subtitle)) || undefined,
    })),
  );
  const state = () => props.choice?.state ?? "superseded";
  const [picked, setPicked] = createSignal<string[]>([]);
  const [sending, setSending] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const chosen = () => (state() === "answered" ? [...(props.choice?.chosen ?? [])] : picked());
  const readOnly = () => state() !== "open" || sending();
  const titleId = `cloud-choice-${props.block.id}`;
  const submit = async () => {
    if (readOnly() || chosen().length === 0 || !props.choice?.submit) return;
    setSending(true);
    setFailed(false);
    const accepted = await props.choice.submit(props.block.id, chosen()).catch(() => false);
    setSending(false);
    if (!accepted) setFailed(true);
  };
  return (
    <section class="cloud-blocks__choice" data-state={state()} aria-labelledby={titleId}>
      <p class="cloud-blocks__question" id={titleId}>
        {props.block.title}
      </p>
      <Show when={props.block.description}>{(description) => <p class="cloud-blocks__hint">{description()}</p>}</Show>
      <Switch>
        <Match when={props.block.mode === "one"}>
          <ChoiceList
            aria-label={props.block.title}
            value={chosen()[0] ?? null}
            disabled={readOnly()}
            options={options().map((option) => ({
              value: option.id,
              label: option.title,
              description: option.subtitle,
              disabled: readOnly() && !chosen().includes(option.id),
            }))}
            onValueChange={(value) => setPicked([value])}
          />
        </Match>
        <Match when={props.block.mode === "many"}>
          <div class="cloud-blocks__checks" role="group" aria-labelledby={titleId}>
            <For each={options()}>
              {(option) => (
                <CheckboxCard
                  label={option.title}
                  description={option.subtitle}
                  value={chosen().includes(option.id)}
                  disabled={readOnly()}
                  onValueChange={(on) => setPicked((current) => (on ? [...current, option.id] : current.filter((id) => id !== option.id)))}
                />
              )}
            </For>
          </div>
        </Match>
      </Switch>
      <div class="cloud-blocks__choice-foot">
        <Switch>
          <Match when={state() === "answered"}>
            <span class="cloud-blocks__choice-state" data-tone="done">
              <i class="ti ti-circle-check" aria-hidden="true" />
              {words().chosenByYou({ time: props.choice?.answeredAt })}
            </span>
          </Match>
          <Match when={state() === "superseded"}>
            <span class="cloud-blocks__choice-state">
              <i class="ti ti-history" aria-hidden="true" />
              {words().superseded}
            </span>
          </Match>
          <Match when={state() === "busy"}>
            <span class="cloud-blocks__choice-state">
              <i class="ti ti-clock" aria-hidden="true" />
              {words().busy}
            </span>
          </Match>
          <Match when={state() === "open"}>
            <span class="cloud-blocks__choice-state" role={failed() ? "alert" : undefined} data-tone={failed() ? "error" : undefined}>
              {failed() ? words().choiceFailed : words().chosenCount({ count: chosen().length })}
            </span>
          </Match>
        </Switch>
        <Show when={state() === "open" || state() === "busy"}>
          <Button
            variant="secondary"
            disabled={state() !== "open" || chosen().length === 0}
            loading={sending()}
            onClick={() => void submit()}
          >
            {props.block.submit}
          </Button>
        </Show>
      </div>
    </section>
  );
}

function DraftBlock(props: { block: Leaf<"Draft">; draft?: BlockDraftState }) {
  const value = (name: string, fallback: unknown) => props.draft?.values[name] ?? text(fallback);
  const editable = () => props.draft?.editable === true;
  return (
    <div class="cloud-blocks__draft" data-editable={editable() ? "" : undefined}>
      <For each={props.block.context ?? []}>
        {(row) => (
          <div class="cloud-blocks__context">
            <span class="cloud-blocks__context-label">{row.label}</span>
            <Show when={Array.isArray(row.value) ? row.value : undefined} fallback={<span>{text(row.value)}</span>}>
              {(people) => (
                <For each={people()}>{(person) => <ReferenceChip kind="person" name={person.name ?? person.address ?? ""} />}</For>
              )}
            </Show>
          </div>
        )}
      </For>
      <For each={props.block.fields}>
        {(field) => (
          <div class="cloud-blocks__field" data-field={field.name}>
            <TextInput
              label={field.label}
              value={
                field.type === "select"
                  ? (field.options?.find((option) => option.value === value(field.name, field.value))?.label ??
                    value(field.name, field.value))
                  : value(field.name, field.value)
              }
              multiline={field.type === "textarea"}
              readOnly={!editable() || field.type === "select"}
              required={field.required}
              onValueChange={(next) => props.draft?.onChange(field.name, next)}
            />
          </div>
        )}
      </For>
    </div>
  );
}

function Leaf(props: {
  block: Block;
  host: BlockTreeProps["host"];
  locale: string;
  timeZone: string;
  choice?: BlockChoiceState;
  draft?: BlockDraftState;
}) {
  const words = () => blockWords(props.locale);
  const block = props.block;
  switch (block.kind) {
    case "Section":
      return (
        <section class="cloud-blocks__section" aria-label={block.title}>
          <h4 class="cloud-blocks__title">
            <Show when={block.icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>
            {block.title}
          </h4>
          <Show when={block.description}>{(description) => <p class="cloud-blocks__hint">{description()}</p>}</Show>
          <BlockTree {...props} blocks={block.children} />
        </section>
      );
    case "Text":
      return <p class="cloud-blocks__text">{block.text}</p>;
    case "Heading":
      return <h4 class="cloud-blocks__title">{block.text}</h4>;
    case "Notice":
      return <NoticeCard tone={block.tone} title={block.title} detail={block.text} />;
    case "Link":
      return (
        <a
          class="cloud-blocks__link"
          href={block.href}
          target={block.href.startsWith("https://") ? "_blank" : undefined}
          rel="noopener noreferrer"
        >
          {block.label}
        </a>
      );
    case "Detail":
      return <DetailBlock block={block} host={props.host} locale={props.locale} />;
    case "Cards":
      return <CardsBlock block={block} locale={props.locale} />;
    case "Image":
      return <ImageBlock block={block} />;
    case "Choice":
      return <ChoiceBlock block={block} locale={props.locale} choice={props.choice} />;
    case "Draft":
      return <DraftBlock block={block} draft={props.draft} />;
    case "Stats":
    case "Table":
    case "Chart":
      return (
        <div class="cloud-blocks__panel" data-kind={block.kind}>
          <DescriptionPanel
            spec={blockJson(blockDescription(block, words(), props.timeZone))}
            title={block.kind === "Chart" ? (block.title ?? block.description?.title ?? "") : block.kind === "Table" ? block.title : ""}
            height={
              block.kind === "Chart"
                ? blockChartHeight(block)
                : block.kind === "Table"
                  ? items(block.rows).length > 8
                    ? BLOCK_PANEL_HEIGHTS.md
                    : 0
                  : 0
            }
            headingLevel={4}
            empty={block.kind === "Table" || block.kind === "Chart" ? block.empty : undefined}
          />
        </div>
      );
    default:
      // Forms, buttons and actions belong to Code pages; the contract keeps them out of every other host.
      return null;
  }
}

/** The blocks of one view in reading order, without a hull of their own. */
export function BlockTree(props: BlockTreeProps): JSX.Element {
  return (
    <div class="cloud-blocks" data-host={props.host}>
      <For each={props.blocks}>
        {(block) => (
          <Leaf block={block} host={props.host} locale={props.locale} timeZone={props.timeZone} choice={props.choice} draft={props.draft} />
        )}
      </For>
    </div>
  );
}
