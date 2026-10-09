/** A fence line: optional quote markers and indentation, then three or more backticks or tildes, then the rest. */
const fenceLine = /^(?:[ \t]*>)*[ \t]*(`{3,}|~{3,})(.*)$/;

/** Whether `line` closes a block that `marker` opened: the same character, at least as many, nothing after it. */
export const closesCodeFence = (line: string, marker: string): boolean => {
  const fence = fenceLine.exec(line);
  return Boolean(fence && fence[1]![0] === marker[0] && fence[1]!.length >= marker.length && !fence[2]!.trim());
};

/** The fenced code block that is still open at `position`, judged by the text before it: its opening line's start and marker. */
export const openCodeFence = (text: string, position: number): { start: number; marker: string } | null => {
  let open: { start: number; marker: string } | null = null;
  let start = 0;
  for (const line of text.slice(0, position).split("\n")) {
    if (open) {
      if (closesCodeFence(line, open.marker)) open = null;
    } else {
      const fence = fenceLine.exec(line);
      // A backtick in the info string makes the line inline code instead of a fence.
      if (fence && !(fence[1]![0] === "`" && fence[2]!.includes("`"))) open = { start, marker: fence[1]! };
    }
    start += line.length + 1;
  }
  return open;
};

export const isInCodeZone = (text: string, position: number): boolean => {
  if (openCodeFence(text, position)) return true;
  const before = text.slice(0, position);
  const line = before.slice(before.lastIndexOf("\n") + 1);
  return (line.match(/`/g) ?? []).length % 2 !== 0;
};
