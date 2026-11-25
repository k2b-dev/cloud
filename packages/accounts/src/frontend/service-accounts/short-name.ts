/** Longest name a row shows whole; a longer one keeps its start and its end, which tell like names apart. */
export const SHORT_NAME_MAX = 48;

/** A long name shortened in the middle ("Nachtlauf-Synchron…-ohne-Leerzeichen"); a short one stays as it is. */
export const shortName = (name: string, max = SHORT_NAME_MAX): string => {
  const signs = [...name];
  if (signs.length <= max) return name;
  const tail = Math.floor((max - 1) / 3);
  return `${signs.slice(0, max - 1 - tail).join("")}…${signs.slice(signs.length - tail).join("")}`;
};
