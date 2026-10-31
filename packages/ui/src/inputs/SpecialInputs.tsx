import { createMemo, type JSX } from "solid-js";
import { useLocale } from "../intl/locale";
import { useUiMessages } from "../intl/messages";
import type { ValueFieldProps } from "./field-contract";
import { resolveMaybeAccessor } from "./field-contract";
import { type IconGroupMessage, useIconMessages } from "./icon-messages";
import { DEFAULT_ICON_GROUPS, DEFAULT_ICON_OPTIONS } from "./icon-options";
import { resolveIconTexts } from "./icon-texts";
import { Select, type SelectGridSize, type SelectGroup, type SelectOption, type SelectView } from "./Select";

export type IconOption = SelectOption & { keywords?: readonly string[] };
export type IconInputProps = ValueFieldProps<string | null> & {
  options?: readonly IconOption[];
  placeholder?: string;
  clearable?: boolean;
  searchLimit?: number;
  groups?: readonly SelectGroup[];
  defaultGroup?: string;
  groupsAriaLabel?: string;
  allGroupLabel?: string;
  viewToggle?: boolean;
  defaultView?: SelectView;
  gridSize?: SelectGridSize;
  name?: string;
};

/** Lowercase without diacritics, so "gross" finds "Groß" and "uber" finds "Über". */
const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/ß/g, "ss")
    .toLowerCase();
const words = (text: string) =>
  fold(text)
    .split(/[^\p{L}\p{N}$€%]+/u)
    .filter(Boolean);

/**
 * Every query word has to appear in the icon's names or keywords: as the start
 * of a word, or anywhere in one once it has three letters, so German compounds
 * such as "Kreditkarte" match "karte". A loose subsequence match let "gro" find
 * "warninG eRrOr", so it is not used. Ranked by where the query hits: the label
 * start, a label word, a keyword, then anywhere.
 */
export const searchIconOptions = <T extends IconOption>(source: readonly T[], query: string, limit: number): T[] => {
  const tokens = words(query);
  if (tokens.length === 0) return [...source];
  const ranked: { option: T; rank: number }[] = [];
  for (const option of source) {
    const labelWords = words(String(option.label));
    const keywordWords = (option.keywords ?? []).flatMap(words);
    const all = [...labelWords, ...keywordWords];
    let rank = 0;
    for (const token of tokens) {
      const tokenRank = labelWords.some((word) => word.startsWith(token))
        ? 1
        : keywordWords.some((word) => word.startsWith(token))
          ? 2
          : token.length >= 3 && all.some((word) => word.includes(token))
            ? 3
            : undefined;
      if (tokenRank === undefined) {
        rank = -1;
        break;
      }
      rank = Math.max(rank, tokenRank);
    }
    if (rank < 0) continue;
    if (rank === 1 && labelWords[0]?.startsWith(tokens[0]!)) rank = 0;
    ranked.push({ option, rank });
  }
  return ranked
    .sort((left, right) => left.rank - right.rank || String(left.option.label).localeCompare(String(right.option.label)))
    .slice(0, limit)
    .map((entry) => entry.option);
};

export function IconInput(props: IconInputProps): JSX.Element {
  const messages = useUiMessages();
  const iconMessages = useIconMessages();
  const locale = useLocale();
  // The bundled catalogue speaks the render locale and stays searchable by
  // its English names, so a mixed team finds the same icon either way.
  const defaultOptions = createMemo((): readonly IconOption[] => {
    const { locale: resolved, t } = resolveIconTexts(locale());
    if (resolved === "en") return DEFAULT_ICON_OPTIONS;
    const texts = t as Record<string, string>;
    return DEFAULT_ICON_OPTIONS.map((option) => {
      const name = option.value.replace("ti ti-", "");
      return {
        ...option,
        label: texts[`${name}.label`] ?? option.label,
        description: texts[`${name}.description`] ?? option.description,
        keywords: [...(option.keywords ?? []), String(option.label), ...(texts[`${name}.keywords`] ?? "").split(" ").filter(Boolean)],
      };
    });
  });
  const options = () => props.options ?? defaultOptions();
  const groups = () =>
    props.groups ??
    (props.options === undefined
      ? DEFAULT_ICON_GROUPS.map((group) => ({ value: group.value, label: iconMessages()[group.value satisfies IconGroupMessage] }))
      : undefined);
  const filterOptions = (source: readonly SelectOption[], query: string): readonly SelectOption[] =>
    query.trim()
      ? searchIconOptions(source, query, props.searchLimit ?? 50)
      : [...source].sort((left, right) => String(left.label).localeCompare(String(right.label), locale(), { sensitivity: "base" }));
  const selectedOption = createMemo(() => options().find((option) => option.value === resolveMaybeAccessor(props.value)));

  return (
    <Select
      id={props.id}
      name={props.name}
      class={props.class}
      label={props.label}
      description={props.description}
      error={props.error}
      aria-label={props["aria-label"]}
      aria-describedby={props["aria-describedby"]}
      placeholder={props.placeholder ?? iconMessages().pickIcon}
      disabled={props.disabled}
      required={props.required}
      clearable={props.clearable ?? true}
      value={resolveMaybeAccessor(props.value)}
      selectedOption={selectedOption()}
      onValueChange={props.onValueChange}
      onValueCommit={props.onValueCommit}
      options={[...options()]}
      groups={groups()}
      defaultGroup={props.defaultGroup ?? (props.options === undefined ? "recommended" : undefined)}
      groupsAriaLabel={props.groupsAriaLabel ?? iconMessages().filterIcons}
      allGroupLabel={props.allGroupLabel}
      viewToggle={props.viewToggle ?? true}
      defaultView={props.defaultView ?? "grid"}
      gridSize={props.gridSize ?? "sm"}
      searchable
      filterOptions={filterOptions}
      searchPlaceholder={messages().search}
      icon={selectedOption()?.icon ?? "ti ti-icons"}
    />
  );
}
