/**
 * A chart is drawn once at its drawing width and CSS stretches it to its box; labels keep their pixel size. On a box
 * narrower than the drawing, neighbouring date labels would meet. Each label therefore names the box width it needs:
 * every second label gives way first, then every fourth, and the first label always stays. The width a label needs is
 * where the labels that remain at its level have the room of the widest label between them.
 */
export const tickRooms = (positions: readonly number[], texts: readonly string[], drawWidth: number): number[] => {
  if (positions.length < 2 || !(drawWidth > 0)) return positions.map(() => 0);
  let spacing = Number.POSITIVE_INFINITY;
  for (let index = 1; index < positions.length; index++) spacing = Math.min(spacing, positions[index]! - positions[index - 1]!);
  if (!(spacing > 0)) return positions.map(() => 0);
  // About 5.6 px a character at the tick labels' 10 px, and a gap between neighbours.
  const label = Math.max(...texts.map((text) => text.length)) * 5.6 + 12;
  return positions.map((_, index) => {
    if (index === 0) return 0;
    // The level of a label is how many times its place halves: 1, 3, 5 give way first, then 2, 6, 10, then 4, 12, …
    const level = Math.log2(index & -index);
    return Math.ceil((label * drawWidth) / (spacing * 2 ** level));
  });
};

/** The style that lets CSS hide a time label (`data-time-tick`) in a box narrower than it needs (`tickRooms`). */
export const tickRoomStyle = (room: number) => (room > 0 ? ` style="--k2b-tick-room:${room}px"` : "");

const tickLabel = /<text class="stdlib-chart-tick-label[^"]*"[^>]*>[^<]*<\/text>/g;
const attribute = (tag: string, name: string) => new RegExp(` ${name}="(-?[\\d.]+)"`).exec(tag)?.[1];

/**
 * Marks the X tick labels of a line drawing that its host stretches (`data-stretch`) with the box width each needs.
 * The X labels are the bottom row of tick labels, the lowest `y` that several labels share; Y labels each have their
 * own. The drawing itself stays as the renderer made it, so only stretching hosts carry the marks.
 */
export const stretchedTickRoomsSvg = (svg: string): string => {
  const drawWidth = Number(/viewBox="0 0 ([\d.]+) /.exec(svg)?.[1]);
  if (!(drawWidth > 0)) return svg;
  const labels = [...svg.matchAll(tickLabel)].map((match) => ({
    tag: match[0],
    x: Number(attribute(match[0], "x")),
    y: attribute(match[0], "y"),
    text: />([^<]*)</.exec(match[0])?.[1] ?? "",
  }));
  const shared = new Map<string, number>();
  for (const label of labels) if (label.y !== undefined) shared.set(label.y, (shared.get(label.y) ?? 0) + 1);
  const row = [...shared]
    .filter(([, count]) => count > 1)
    .map(([y]) => y)
    .sort((a, b) => Number(b) - Number(a))[0];
  const axis = labels.filter((label) => label.y === row && Number.isFinite(label.x));
  if (axis.length < 2) return svg;
  const rooms = tickRooms(
    axis.map((label) => label.x),
    axis.map((label) => label.text),
    drawWidth,
  );
  const marks = new Map(axis.map((label, index) => [label, rooms[index]!]));
  let next = 0;
  return svg.replace(tickLabel, (tag) => {
    const label = labels[next++];
    const room = label ? marks.get(label) : undefined;
    if (room === undefined) return tag;
    // A responsive drawing already gives each label a style; the room joins it, a second attribute would be ignored.
    const marked = tag.replace(/^<text /, "<text data-time-tick ");
    if (room <= 0) return marked;
    return / style="/.test(marked)
      ? marked.replace(/ style="([^"]*)"/, (_match, style: string) => ` style="${style};--k2b-tick-room:${room}px"`)
      : marked.replace(/^(<text[^>]*)>/, `$1${tickRoomStyle(room)}>`);
  });
};
