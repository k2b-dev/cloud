// ==========================
// Streaming Parser Utilities
// ==========================

/**
 * A parsed Server-Sent Event.
 *
 * @property event - The event type (from the `event:` field). Omitted when no type was specified.
 * @property data  - The event payload. Multiline `data:` fields are concatenated with `\n`.
 * @property id    - The event ID (from the `id:` field). Omitted when not present.
 */
export type SSEEvent = { event?: string; data: string; id?: string };

/**
 * Async generator that parses a Server-Sent Events stream (RFC 6202).
 *
 * Consumes a `ReadableStream<Uint8Array>` — typically obtained from
 * `fetch(...).then(r => r.body!)` — and yields one {@link SSEEvent} object
 * for every event frame in the stream.
 *
 * Implementation details:
 * - Buffers incomplete lines across chunks so split boundaries are transparent.
 * - Normalizes `\r\n` and `\r` to `\n` before processing.
 * - Skips comment lines (lines starting with `:`).
 * - Concatenates multiple `data:` fields within a single event with `\n`.
 * - An empty line (double newline) signals the end of an event frame.
 * - The stream is fully consumed when the generator completes.
 *
 * @param stream - A readable byte stream of SSE-formatted text.
 * @returns An async generator yielding {@link SSEEvent} objects.
 *
 * @example
 * const res = await fetch("/events", { headers: { Accept: "text/event-stream" } });
 * for await (const event of streaming.parseSSE(res.body!)) {
 *   console.log(event.event, event.data);
 * }
 */
export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";

  let eventType: string | undefined;
  let dataLines: string[] = [];
  let eventId: string | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Normalize CRLF → LF first.
      buffer = buffer.replace(/\r\n/g, "\n");
      // A trailing bare \r might be the first half of a CRLF whose \n is in
      // the next chunk. Hold it back so we don't dispatch the line early.
      let trailingCR = "";
      if (buffer.endsWith("\r")) {
        trailingCR = "\r";
        buffer = buffer.slice(0, -1);
      }
      // Mid-buffer bare \r is a legitimate line separator per the spec.
      buffer = buffer.replace(/\r/g, "\n");

      const lines = buffer.split("\n");
      // Last element may be an incomplete line — keep it in the buffer.
      buffer = lines.pop()! + trailingCR;

      for (const line of lines) {
        // Empty line = dispatch event
        if (line === "") {
          if (dataLines.length > 0) {
            const event: SSEEvent = { data: dataLines.join("\n") };
            if (eventType !== undefined) event.event = eventType;
            if (eventId !== undefined) event.id = eventId;
            yield event;
          }
          // Reset fields for next event
          eventType = undefined;
          dataLines = [];
          eventId = undefined;
          continue;
        }

        // Skip comment lines
        if (line.startsWith(":")) continue;

        const colonIdx = line.indexOf(":");
        let field: string;
        let value: string;

        if (colonIdx === -1) {
          // Field with no value
          field = line;
          value = "";
        } else {
          field = line.slice(0, colonIdx);
          // Strip single leading space after colon per spec
          value = line[colonIdx + 1] === " " ? line.slice(colonIdx + 2) : line.slice(colonIdx + 1);
        }

        switch (field) {
          case "event":
            eventType = value;
            break;
          case "data":
            dataLines.push(value);
            break;
          case "id":
            eventId = value;
            break;
          // "retry" and unknown fields are ignored per spec
        }
      }
    }

    // Flush any remaining data in the decoder
    buffer += decoder.decode();
    buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    // Process any remaining lines after stream ends
    if (buffer.length > 0) {
      const lines = buffer.split("\n");
      for (const line of lines) {
        if (line === "") {
          if (dataLines.length > 0) {
            const event: SSEEvent = { data: dataLines.join("\n") };
            if (eventType !== undefined) event.event = eventType;
            if (eventId !== undefined) event.id = eventId;
            yield event;
          }
          eventType = undefined;
          dataLines = [];
          eventId = undefined;
          continue;
        }
        if (line.startsWith(":")) continue;

        const colonIdx = line.indexOf(":");
        let field: string;
        let value: string;

        if (colonIdx === -1) {
          field = line;
          value = "";
        } else {
          field = line.slice(0, colonIdx);
          value = line[colonIdx + 1] === " " ? line.slice(colonIdx + 2) : line.slice(colonIdx + 1);
        }

        switch (field) {
          case "event":
            eventType = value;
            break;
          case "data":
            dataLines.push(value);
            break;
          case "id":
            eventId = value;
            break;
        }
      }
    }

    // Emit final event if stream ended without trailing blank line
    if (dataLines.length > 0) {
      const event: SSEEvent = { data: dataLines.join("\n") };
      if (eventType !== undefined) event.event = eventType;
      if (eventId !== undefined) event.id = eventId;
      yield event;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Async generator that parses a newline-delimited JSON (NDJSON) stream.
 *
 * Consumes a `ReadableStream<Uint8Array>` — typically obtained from
 * `fetch(...).then(r => r.body!)` — and yields one parsed object per
 * JSON line.
 *
 * Implementation details:
 * - Buffers incomplete lines across chunks so split boundaries are transparent.
 * - Skips empty lines.
 * - Malformed JSON lines are silently skipped with a `console.warn` — the
 *   generator never throws on bad input.
 * - The stream is fully consumed when the generator completes.
 *
 * @typeParam T - The expected shape of each parsed JSON object.
 * @param stream - A readable byte stream of NDJSON-formatted text.
 * @returns An async generator yielding parsed objects of type `T`.
 *
 * @example
 * const res = await fetch("/api/logs");
 * for await (const entry of streaming.parseNDJSON<LogEntry>(res.body!)) {
 *   console.log(entry.level, entry.message);
 * }
 */
export async function* parseNDJSON<T = unknown>(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<T> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      // Last element may be an incomplete line — keep it in the buffer
      buffer = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "") continue;

        try {
          yield JSON.parse(trimmed) as T;
        } catch {
          console.warn(`[parseNDJSON] Skipping malformed line: ${trimmed}`);
        }
      }
    }

    // Flush any remaining data in the decoder
    buffer += decoder.decode();

    // Process the final buffered line
    const trimmed = buffer.trim();
    if (trimmed !== "") {
      try {
        yield JSON.parse(trimmed) as T;
      } catch {
        console.warn(`[parseNDJSON] Skipping malformed line: ${trimmed}`);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export const streaming = {
  parseSSE,
  parseNDJSON,
} as const;
