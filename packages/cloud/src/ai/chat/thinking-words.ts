import { i18n } from "@k2b/stdlib";

/**
 * The words a thinking phase shows after its first word ("Thinking", `stepThinking` in the chat catalog), and the one
 * sentence screen readers hear (Feinschliff v3, section 1: 19 words, approved by Valentin on 15.11.). English uses the
 * -ing form like the rest of the chat. A catalog holds texts, so each list is one text with "|" between its words.
 */
const thinkingMessages = /* @__PURE__ */ i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      plain:
        "Pondering|Tinkering|Puzzling it out|Weighing it up|Putting two and two together|Sorting things out|Sifting through|Piecing it together|Tidying up|Connecting the dots|Double-checking the sums",
      wink: "Sharpening the pencil|Polishing the glasses|Furrowing the brow|Rolling up the sleeves|Reading the small print|Bringing order to the chaos",
      moustache: "Twirling the moustache|Consulting the moustache",
      announcement: ({ assistant }: { assistant: string }) => `${assistant} is thinking`,
    },
    de: {
      plain: "Grübelt|Tüftelt|Knobelt|Wägt ab|Kombiniert|Sortiert|Sichtet|Puzzelt|Ordnet|Verknüpft|Rechnet nach",
      wink: "Spitzt den Bleistift|Putzt die Brille|Legt die Stirn in Falten|Krempelt die Ärmel hoch|Liest das Kleingedruckte|Bringt Ordnung ins Chaos",
      moustache: "Zwirbelt den Schnurrbart|Hält Rücksprache mit dem Schnurrbart",
      announcement: ({ assistant }) => `${assistant} denkt nach`,
    },
  },
});

/** The thinking words and the announcement in the reader's language. */
export const aiThinkingMessages = (locale: string) => thinkingMessages.resolve([locale]).t;

/** The words of one language by kind. */
export type AiThinkingWords = {
  plain: readonly string[];
  wink: readonly string[];
  moustache: readonly string[];
};

/** A number from the id of a thinking phase (FNV-1a), so the same phase gets the same round everywhere. */
const seedOf = (id: string): number => {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
};

const randomFrom = (start: number) => {
  let seed = start;
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
};

const shuffled = (list: readonly string[], random: () => number): string[] => {
  const out = [...list];
  for (let index = out.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [out[index], out[other]] = [out[other]!, out[index]!];
  }
  return out;
};

/**
 * One round of words for a thinking phase, seeded by its id: it starts with two plain verbs, then winks and plain verbs
 * take turns, so two winks never follow each other, and the two moustache words fall into different halves. No word
 * repeats within the round; the same id gives the same round on the server and in the browser.
 */
export const aiThinkingWordRound = (id: string, words: AiThinkingWords): string[] => {
  const random = randomFrom(seedOf(id));
  const plain = shuffled(words.plain, random);
  const wink = shuffled(words.wink, random);
  const [early, late] = words.moustache;
  const half = Math.ceil((wink.length + words.moustache.length) / 2);
  if (early) wink.splice(Math.floor(random() * Math.min(half, wink.length + 1)), 0, early);
  if (late) wink.splice(half + Math.floor(random() * (wink.length + 1 - half)), 0, late);
  const round = plain.splice(0, 2);
  while (plain.length > 0 || wink.length > 0) {
    const next = wink.shift();
    if (next) round.push(next);
    const verb = plain.shift();
    if (verb) round.push(verb);
  }
  return round;
};

/** The words of a language, ready for `aiThinkingWordRound`. */
export const aiThinkingWords = (locale: string): AiThinkingWords => {
  const t = aiThinkingMessages(locale);
  const list = (words: string) => words.split("|");
  return { plain: list(t.plain), wink: list(t.wink), moustache: list(t.moustache) };
};
