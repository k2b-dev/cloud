import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { createLineReader, type LineReader } from "./line-reader";

const readers: LineReader[] = [];
afterEach(() => {
  for (const reader of readers.splice(0)) reader.close();
});
const setup = () => {
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { isTTY: true });
  let printed = "";
  output.on("data", (data) => {
    printed += data.toString();
  });
  const reader = createLineReader({ input, output });
  readers.push(reader);
  return { input, reader, printed: () => printed };
};
const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("Assistant line reader", () => {
  test("a bracketed paste sends its three lines only after Enter", async () => {
    const { input, reader } = setup();
    const message = reader.readMessage("> ");
    let sent = false;
    void message.then(() => {
      sent = true;
    });
    input.write(paste("one\ntwo\nthree\n"));
    await tick();
    expect(sent).toBeFalse();
    input.write("\r");
    expect(await message).toBe("one\ntwo\nthree\n");
  });

  test("a paste without a trailing newline waits for Enter too", async () => {
    const { input, reader } = setup();
    const message = reader.readMessage("> ");
    let sent = false;
    void message.then(() => {
      sent = true;
    });
    input.write(paste("one\ntwo\nthree"));
    await tick();
    expect(sent).toBeFalse();
    input.write("\r");
    expect(await message).toBe("one\ntwo\nthree");
  });

  test("one trailing backslash continues; two remain literal", async () => {
    const { input, reader, printed } = setup();
    const message = reader.readMessage("> ");
    input.write("one\\\r");
    expect(printed()).toContain("  ");
    input.write("two\r");
    expect(await message).toBe("one\ntwo");
    const literal = reader.readMessage("> ");
    input.write("two\\\\\r");
    expect(await literal).toBe("two\\\\");
  });

  test("drops idle lines, reports once, and never answers the next question", async () => {
    const { input, reader, printed } = setup();
    input.write("y\ry\r");
    expect(printed().match(/Input is ignored/g)).toHaveLength(1);
    const answer = reader.read("Approve? ", { typedOnly: true });
    input.write("n\r");
    expect(await answer).toBe("n");
    input.write("y\r");
    expect(printed().match(/Input is ignored/g)).toHaveLength(2);
  });

  test("clears partial typed-ahead input before asking", async () => {
    const { input, reader } = setup();
    input.write("y");
    const answer = reader.read("Approve? ", { typedOnly: true });
    input.write("\r");
    expect(await answer).toBe("");
  });

  test("pasted answers cannot approve but a subsequent typed answer can", async () => {
    const { input, reader, printed } = setup();
    const answer = reader.read("Approve? ", { typedOnly: true });
    let approved = false;
    void answer.then(() => {
      approved = true;
    });
    input.write(paste("y\n"));
    await tick();
    expect(approved).toBeFalse();
    expect(printed()).toContain("Pasted input does not answer this question. Type your answer.");
    input.write("y\r");
    expect(await answer).toBe("y");
  });

  test("rejects pasted partial answers and accepts multiline survey text after Enter", async () => {
    const { input, reader } = setup();
    const answer = reader.read("Approve? ", { typedOnly: true });
    input.write(paste("y"));
    input.write("\r");
    input.write("n\r");
    expect(await answer).toBe("n");
    const survey = reader.read("Details: ");
    input.write(paste("one\ntwo"));
    input.write("\r");
    expect(await survey).toBe("one\ntwo");
  });

  test("Ctrl+C clears typed and buffered messages before interrupting at an empty prompt", async () => {
    const { input, reader } = setup();
    const interrupts: boolean[] = [];
    reader.onInterrupt((question) => {
      interrupts.push(question);
    });
    const message = reader.readMessage("> ");
    input.write("partial\x03");
    expect(interrupts).toEqual([]);
    input.write("buffer\\\r\x03");
    expect(interrupts).toEqual([]);
    input.write("done\r");
    expect(await message).toBe("done");
    const empty = reader.readMessage("> ");
    input.write("\x03");
    expect(interrupts).toEqual([false]);
    reader.close();
    expect(await empty).toBeNull();
  });

  test("Ctrl+C cancels a typed question and leaves the following Enter idle", async () => {
    const { input, reader, printed } = setup();
    const interrupts: boolean[] = [];
    reader.onInterrupt((question) => interrupts.push(question));
    const answer = reader.read("Approve? ", { typedOnly: true });
    input.write("y\x03\r");
    expect(await answer).toBeNull();
    expect(interrupts).toEqual([true]);
    expect(printed()).toContain("Input is ignored");
    const next = reader.read("Again? ", { typedOnly: true });
    input.write("n\r");
    expect(await next).toBe("n");
  });

  test("discards input buffered while paused before the next question", async () => {
    const { input, reader, printed } = setup();
    reader.pause?.();
    input.write("y\r");
    reader.resume?.();
    const answer = reader.read("Use this text? ", { typedOnly: true });
    await tick();
    input.write("n\r");
    expect(await answer).toBe("n");
    expect(printed()).not.toContain("Input is ignored");
  });

  test("enables bracketed paste once and disables it around pause and close", async () => {
    const { reader, printed } = setup();
    expect(printed()).toBe("\x1b[?2004h");
    reader.pause?.();
    reader.resume?.();
    reader.close();
    expect(printed()).toBe("\x1b[?2004h\x1b[?2004l\x1b[?2004h\x1b[?2004l");
    expect(await reader.readMessage("> ")).toBeNull();
  });
});
