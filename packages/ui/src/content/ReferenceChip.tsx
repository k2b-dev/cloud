import { type JSX, Show } from "solid-js";
import { Avatar } from "../surfaces/Avatar";

/** The visible length of a chip; longer titles are cut in the middle. */
export const REFERENCE_CHIP_MAX_CHARACTERS = 40;

/** Up to this length a chip stays on one line; a longer one may wrap inside its fill. */
const UNBROKEN_CHARACTERS = 30;

const graphemes = (text: string): string[] =>
  typeof Intl.Segmenter === "function"
    ? Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (part) => part.segment)
    : Array.from(text);

/**
 * Shortens `text` to at most `max` visible characters by cutting its middle, so the start and an ending such as
 * ".pdf" stay readable. Counts user-perceived characters, so an emoji is never split.
 * @example truncateMiddle("Quarterly report for the operations team 2026.pdf", 24) // "Quarterly re…m 2026.pdf"
 */
export const truncateMiddle = (text: string, max: number = REFERENCE_CHIP_MAX_CHARACTERS): string => {
  const characters = graphemes(text);
  if (characters.length <= max) return text;
  if (max < 2) return "…";
  const tail = Math.floor((max - 1) / 2);
  const head = max - 1 - tail;
  return `${characters.slice(0, head).join("").trimEnd()}…${characters
    .slice(characters.length - tail)
    .join("")
    .trimStart()}`;
};

type ReferenceChipCommon = {
  class?: string;
};

/** A thing or a place: an icon in its application colour and its title, a link while it exists. */
export type ReferenceChipObjectProps = ReferenceChipCommon & {
  kind: "object" | "place";
  title: string;
  /** Destination of the chip. Omit it, or set `gone`, when there is nothing to open. */
  href?: string;
  /** Icon class, for example `ti ti-mail`. */
  icon?: string;
  /** Icon colour, usually the owning application's accent. Sets `--k2b-reference-icon`. */
  accent?: string;
  /** The thing no longer exists: struck through and never a link. */
  gone?: boolean;
};

/** A person: avatar and display name. The address belongs in the preview, never in the chip. */
export type ReferenceChipPersonProps = ReferenceChipCommon & {
  kind: "person";
  name: string;
  /** Avatar image; initials on a tint from the name otherwise. */
  src?: string | null;
  href?: string;
};

/** A date or time the host already formatted for the reader. */
export type ReferenceChipTimeProps = ReferenceChipCommon & {
  kind: "time";
  label: string;
  /** Machine-readable value for `<time datetime>`. */
  dateTime?: string;
};

export type ReferenceChipProps = ReferenceChipObjectProps | ReferenceChipPersonProps | ReferenceChipTimeProps;

const fullText = (props: ReferenceChipProps): string =>
  props.kind === "person" ? props.name : props.kind === "time" ? props.label : props.title;

/**
 * A typed reference inside a sentence: a thing, a place, a person, or a time, in the calm `.k2b-reference` pill.
 * A chip shows at most 40 characters and cuts longer titles in the middle; the full title stays its accessible name
 * and tooltip.
 * @example <ReferenceChip kind="object" title="Maintenance window" icon="ti ti-mail" accent="var(--app-mail)" href="/mail/…" />
 */
export function ReferenceChip(props: ReferenceChipProps): JSX.Element {
  const full = () => fullText(props);
  const visible = () => truncateMiddle(full());
  const cut = () => visible() !== full();
  const gone = () => props.kind !== "person" && props.kind !== "time" && props.gone === true;
  const href = () => (gone() || props.kind === "time" ? undefined : props.href);
  const accent = () => (props.kind === "object" || props.kind === "place" ? props.accent : undefined);
  const icon = () => (props.kind === "time" ? "ti ti-clock" : props.kind === "object" || props.kind === "place" ? props.icon : undefined);

  const content = () => (
    <>
      <Show when={props.kind === "person" ? props : undefined}>
        {(person) => (
          <span class="k2b-reference__avatar" aria-hidden="true">
            <Avatar name={person().name} src={person().src} size="xs" />
          </span>
        )}
      </Show>
      <Show when={icon()}>{(name) => <i class={`k2b-reference__icon ${name()}`} aria-hidden="true" />}</Show>
      <Show when={cut()} fallback={full()}>
        <span class="k2b-sr-only">{full()}</span>
        <span aria-hidden="true">{visible()}</span>
      </Show>
    </>
  );

  const shared = () => ({
    class: `k2b-reference k2b-reference-chip${props.class ? ` ${props.class}` : ""}`,
    "data-kind": props.kind,
    "data-gone": gone() ? "true" : undefined,
    "data-long": visible().length > UNBROKEN_CHARACTERS ? "true" : undefined,
    title: cut() ? full() : undefined,
    style: accent() ? { "--k2b-reference-icon": accent() } : undefined,
  });

  return (
    <Show
      when={href()}
      fallback={
        <Show when={props.kind === "time" ? props : undefined} fallback={<span {...shared()}>{content()}</span>}>
          {(time) => (
            <time {...shared()} dateTime={time().dateTime}>
              {content()}
            </time>
          )}
        </Show>
      }
    >
      {(link) => (
        <a {...shared()} href={link()}>
          {content()}
        </a>
      )}
    </Show>
  );
}

export default ReferenceChip;
