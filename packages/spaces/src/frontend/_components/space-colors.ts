import { i18n } from "@k2b/stdlib";

/** The named colours a Space picks from on v2, in the order they are offered. */
export const SPACE_COLORS = [
  ["blue", "#3b82f6"],
  ["indigo", "#6366f1"],
  ["violet", "#8b5cf6"],
  ["pink", "#ec4899"],
  ["red", "#ef4444"],
  ["orange", "#f97316"],
  ["yellow", "#eab308"],
  ["green", "#10b981"],
  ["teal", "#06b6d4"],
  ["gray", "#6b7280"],
] as const;

type ColorName = (typeof SPACE_COLORS)[number][0];

const colorMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      blue: "Blue",
      indigo: "Indigo",
      violet: "Violet",
      pink: "Pink",
      red: "Red",
      orange: "Orange",
      yellow: "Yellow",
      green: "Green",
      teal: "Teal",
      gray: "Gray",
      own: ({ hex }: { hex: string }) => `Own colour (${hex})`,
    } satisfies Record<ColorName, string> & { own: (params: { hex: string }) => string },
    de: {
      blue: "Blau",
      indigo: "Indigo",
      violet: "Violett",
      pink: "Rosa",
      red: "Rot",
      orange: "Orange",
      yellow: "Gelb",
      green: "Grün",
      teal: "Türkis",
      gray: "Grau",
      own: ({ hex }: { hex: string }) => `Eigene Farbe (${hex})`,
    },
  },
});

/** The palette as select options; a colour outside it (set before v2 or through the API) stays chosen as its own entry. */
export const spaceColorOptions = (locale: string, current: string) => {
  const { t } = colorMessages.resolve([locale]);
  const options: { value: string; label: string }[] = SPACE_COLORS.map(([name, hex]) => ({ value: hex, label: t[name] }));
  const known = options.some((option) => option.value.toLowerCase() === current.toLowerCase());
  return known || !current ? options : [...options, { value: current, label: t.own({ hex: current }) }];
};
