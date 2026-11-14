/** Shared UTF-8 byte slicing for chat and run-bound file readers. */
export const readUtf8Slice = (input: {
  bytes: Uint8Array;
  offset: number;
  requestedEnd: number;
  totalBytes: number;
  path: string;
}): { content: string; nextOffset: number; eof: boolean } => {
  let end = -1;
  let content = "";
  for (let trim = 0; trim <= Math.min(3, input.bytes.byteLength); trim += 1) {
    try {
      const candidateEnd = input.bytes.byteLength - trim;
      content = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes.slice(0, candidateEnd));
      end = candidateEnd;
      break;
    } catch {
      // A bounded slice can end inside one UTF-8 code point (at most 3 bytes).
    }
  }
  if (end < 0) throw new Error(`File ${input.path} is not valid UTF-8 at byte ${input.offset}.`);
  if (end === 0 && input.requestedEnd > input.offset) {
    throw new Error(`Offset ${input.offset} is not on a UTF-8 character boundary.`);
  }

  const nextOffset = input.offset + end;
  return { content, nextOffset, eof: nextOffset >= input.totalBytes };
};
