/**
 * E-mail addresses in a typed or pasted text, read in one pass: `a@b.example`, `Name <a@b.example>` and
 * `"Berg, Anna" <a@b.example>`. Commas, semicolons and new lines end an address, and so does a space after a bare one.
 * A comma before `<…>` with no address before it belongs to the name (`Berg, Anna <a@b.example>`). The time grows with
 * the length of the text, never faster.
 */

export type ScannedAddresses = {
  /** The addresses in their display form (`Name <a@b.example>` or `a@b.example`), in their order. */
  found: string[];
  /** What is no address, with its own separators, to stay in the field. */
  rest: string;
};

const separator = (c: string) => c === "," || c === ";" || c === "\n" || c === "\r";
const space = (c: string) => c === " " || c === "\t";

/** The address of a display form: what stands in `<…>`, or the whole. */
export const addressOf = (display: string): string => {
  const open = display.lastIndexOf("<");
  return (open >= 0 && display.endsWith(">") ? display.slice(open + 1, -1) : display).trim();
};

/** Whether a text is one address: a local part, an @ and a domain with a dot, no spaces, quotes or brackets. */
export const isAddress = (text: string): boolean => {
  const at = text.indexOf("@");
  if (at <= 0 || at !== text.lastIndexOf("@")) return false;
  const domain = text.slice(at + 1);
  const dot = domain.indexOf(".");
  if (dot <= 0 || dot === domain.length - 1) return false;
  for (const c of text) if (space(c) || separator(c) || c === "<" || c === ">" || c === '"' || c === "\n") return false;
  return true;
};

/** The same address in another form or case: the key two chips must not share. */
export const addressKey = (display: string): string => addressOf(display).toLowerCase();

export const scanAddresses = (text: string): ScannedAddresses => {
  const tokens: [number, number][] = [];
  let start = 0;
  let quoted = false;
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
    start = end + 1;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === "\\") i++;
      else if (c === '"') quoted = false;
      continue;
    }
    if (angled) {
      if (c === ">") {
        angled = false;
        address = true;
      }
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === "<") {
      angled = true;
      held = [];
    } else if (c === "@") address = true;
    else if (separator(c) || (space(c) && address)) {
      if (address) cut(i);
      else if (separator(c)) held.push(i);
    }
  }
  if (start <= text.length) cut(text.length);

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
  rest += text.slice(at);
  return { found, rest: trimSeparators(rest) };
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
