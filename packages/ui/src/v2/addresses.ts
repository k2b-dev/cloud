/**
 * E-mail addresses in a typed or pasted text, read in one pass: `a@b.example`, `Name <a@b.example>`,
 * `"Berg, Anna" <a@b.example>` and Outlook's `'a@b.example' <a@b.example>`. A semicolon and a new line always end an
 * entry; a comma ends one too, except a comma before `<…>` with no address before it, which belongs to the name
 * (`Berg, Anna <a@b.example>`); a space ends a bare address. A quote or a `<` that is never closed holds the rest of
 * the text, which is then no address and stays. The time grows with the length of the text, never faster.
 */
import { addressOf } from "./address-of";

export type ScannedAddresses = {
  /** The addresses in their display form (`Name <a@b.example>` or `a@b.example`), in their order. */
  found: string[];
  /** What is no address, with its own separators, to stay in the field. */
  rest: string;
};

const separator = (c: string) => c === "," || c === ";" || c === "\n" || c === "\r";
/** A separator that always ends an entry: only a comma may belong to a name. */
const hard = (c: string) => c === ";" || c === "\n" || c === "\r";
const space = (c: string) => c === " " || c === "\t";

export { addressOf };

/** Whether a text is one address: a local part, an @ and a domain with a dot, no spaces, quotes or brackets. */
export const isAddress = (text: string): boolean => {
  const at = text.indexOf("@");
  if (at <= 0 || at !== text.lastIndexOf("@")) return false;
  const domain = text.slice(at + 1);
  const dot = domain.indexOf(".");
  if (dot <= 0 || domain.endsWith(".") || domain.includes("..")) return false;
  for (const c of text) if (space(c) || separator(c) || c === "<" || c === ">" || c === '"' || c === "\n") return false;
  return true;
};

/** The same address in another form or case: the key two chips must not share. */
export const addressKey = (display: string): string => addressOf(display).toLowerCase();

/**
 * With `final` the last entry counts too; without, only entries a separator closed, so an address still being typed
 * (`mia@lindqvist.e`) is not taken before it is done (Enter, a paste or leaving the field take it).
 */
export const scanAddresses = (text: string, { final = true }: { final?: boolean } = {}): ScannedAddresses => {
  const tokens: [number, number][] = [];
  let start = 0;
  // the quote that opened a quoted name: `"`, or `'` at the start of an entry (Outlook's `'a@b' <a@b>`; inside a
  // name, as in O'Brien, it is a letter)
  let quoted: string | null = null;
  let fresh = true;
  let angled = false;
  let address = false;
  // separators in a token before its address: they end it, unless `<…>` comes after them (then they are its name's)
  let held: number[] = [];
  const cut = (end: number) => {
    let from = start;
    for (const at of held) {
      tokens.push([from, at]);
      from = at + 1;
    }
    tokens.push([from, end]);
    held = [];
    address = false;
    fresh = true;
    start = end + 1;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === "\\") i++;
      else if (c === quoted) quoted = null;
      continue;
    }
    if (angled) {
      if (c === ">") {
        angled = false;
        address = true;
      }
      continue;
    }
    const first = fresh && !space(c) && !separator(c);
    if (!space(c) && !separator(c)) fresh = false;
    if (c === '"' || (c === "'" && first)) quoted = c;
    else if (c === "<") {
      angled = true;
      held = [];
    } else if (c === "@") address = true;
    else if (separator(c) || (space(c) && address)) {
      if (address || hard(c)) cut(i);
      else held.push(i);
    }
  }
  // the entry after the last separator: taken when the text is done, else it is still being typed, and stays so
  const typing = final ? "" : text.slice(start);
  if (final) cut(text.length);

  const found: string[] = [];
  const taken: [number, number][] = [];
  for (const [from, to] of tokens) {
    const display = text.slice(from, to).trim();
    if (display && isAddress(addressOf(display))) {
      found.push(display);
      taken.push([from, to]);
    }
  }
  // the rest keeps its own words and separators; only the addresses taken out leave it
  let rest = "";
  let at = 0;
  for (const [from, to] of taken) {
    rest += text.slice(at, from);
    at = to;
  }
  rest += text.slice(at, final ? text.length : start);
  const closed = trimSeparators(rest);
  const open = typing.trimStart();
  if (!open) return { found, rest: closed };
  // a closed rest and the open entry keep the separator between them
  const between = text[start - 1] === "," || text[start - 1] === ";" ? `${text[start - 1]} ` : "\n";
  return { found, rest: closed ? closed + between + open : open };
};

/** A text without separators and spaces at its ends, and with one in place of a run of them inside. */
const trimSeparators = (text: string): string => {
  let out = "";
  let pending = "";
  for (const c of text) {
    if (separator(c) || space(c)) {
      // a separator wins over a space inside a run, so "a ,  b" keeps its comma
      if (!pending || (separator(c) && !separator(pending))) pending = c === "\r" ? "\n" : c;
      continue;
    }
    if (out && pending) out += pending === "\n" ? "\n" : separator(pending) ? `${pending} ` : " ";
    pending = "";
    out += c;
  }
  return out;
};
