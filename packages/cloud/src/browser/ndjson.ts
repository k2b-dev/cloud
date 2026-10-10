/** Media type Core streams per-app results in; kept local so browser bundles do not load server schemas. */
export const NDJSON_CONTENT_TYPE = "application/x-ndjson";

/**
 * Hands over each line of an NDJSON response as it arrives, until a line of type `done`. Rejects when the stream ends
 * before that line, so the caller can tell a finished stream from one that broke off.
 */
export const readNdjsonLines = async <Line extends { type: string }>(
  response: Response,
  onLine: (line: Line) => void,
  name: string,
): Promise<void> => {
  if (!response.body) throw new Error(`${name} returned no body`);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let closed = false;
  while (!closed) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += chunk.value;
    let end = buffer.indexOf("\n");
    while (end >= 0) {
      const text = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (text) {
        const line: Line = JSON.parse(text);
        onLine(line);
        if (line.type === "done") closed = true;
      }
      end = buffer.indexOf("\n");
    }
  }
  if (!closed) throw new Error(`${name} stream ended early`);
};
