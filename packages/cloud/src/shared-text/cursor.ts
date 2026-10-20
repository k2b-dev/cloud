const STREAM_CURSOR_REGEX = /^s6t\.[A-Za-z0-9_-]+\.\d+$/;

export const parseStreamCursor = (cursor: string | null | undefined): { resource: string; seq: number } | null => {
  if (!cursor || !STREAM_CURSOR_REGEX.test(cursor)) return null;
  const [, resource, sequence] = cursor.split(".");
  const seq = Number(sequence);
  if (!resource || !Number.isSafeInteger(seq) || seq < 0) return null;
  return { resource, seq };
};

export const compareStreamCursor = (left: string, right: string): number => {
  const l = parseStreamCursor(left);
  const r = parseStreamCursor(right);
  if (!l || !r || l.resource !== r.resource) throw new Error(`Invalid stream cursor comparison: "${left}" vs "${right}"`);
  return l.seq - r.seq;
};

export const maxStreamCursor = (a: string | null, b: string | null): string | null => {
  if (!a) return b;
  if (!b) return a;
  return compareStreamCursor(a, b) >= 0 ? a : b;
};
