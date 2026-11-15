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
