import { describe, expect, test } from "bun:test";
import { selectNumberedChoice, terminalInfo, terminalSafeModelText, terminalSafeText } from "./terminal";

const createOutput = () => {
  const printed: string[] = [];
  const errors: string[] = [];
  return {
    output: {
      print: (value = "") => printed.push(value),
      error: (value: string) => errors.push(value),
    },
    printed,
    errors,
  };
};

describe("Assistant terminal helpers", () => {
  test("escapes terminal control and bidirectional text before display", () => {
    expect(terminalSafeText("safe\u001b[2J\rhidden\u202Etxt")).toBe("safe\\u001b[2J\\u000dhidden\\u202etxt");
  });

  test("keeps line breaks and tabs in model text and escapes every other control character", () => {
    expect(terminalSafeModelText("a\n\tb\r\u001b[8m\u2066c")).toBe("a\n\tb\\u000d\\u001b[8m\\u2066c");
  });

  test("renders a blue info label without coloring or trusting its message", () => {
    expect(terminalInfo("New chat\u001b[2J")).toBe("\u001b[34mInfo:\u001b[0m New chat\\u001b[2J");
  });

  test("re-prompts after invalid input and returns a numbered choice", async () => {
    const values = ["wrong", "3", "2"];
    const { output, printed, errors } = createOutput();

    const selected = await selectNumberedChoice({
      output,
      reader: { read: async () => values.shift() ?? null },
      title: "Choose:",
      prompt: "Choice: ",
      choices: [
        { value: "first", label: "First" },
        { value: "second", label: "Second", description: "Current\nchoice", current: true },
      ],
    });

    expect(selected).toBe("second");
    expect(printed).toContain("  2. Second · Current choice [current]");
    expect(errors).toEqual(["Enter a number from 1-2, or press Enter to cancel.", "Enter a number from 1-2, or press Enter to cancel."]);
  });

  test("supports a zero choice and cancels on an empty line or EOF", async () => {
    const resetOutput = createOutput();
    expect(
      await selectNumberedChoice<string | null>({
        output: resetOutput.output,
        reader: { read: async () => "0" },
        title: "Choose:",
        prompt: "Choice: ",
        zeroChoice: { value: null, label: "Default" },
        choices: [{ value: "custom", label: "Custom" }],
      }),
    ).toBeNull();

    for (const answer of ["", null]) {
      const cancelledOutput = createOutput();
      expect(
        await selectNumberedChoice({
          output: cancelledOutput.output,
          reader: { read: async () => answer },
          title: "Choose:",
          prompt: "Choice: ",
          choices: [{ value: "custom", label: "Custom" }],
        }),
      ).toBeUndefined();
    }
  });

  test("reports an empty picker without prompting", async () => {
    const { output, printed } = createOutput();
    let prompted = false;

    expect(
      await selectNumberedChoice({
        output,
        reader: {
          read: async () => {
            prompted = true;
            return null;
          },
        },
        title: "Choose:",
        prompt: "Choice: ",
        choices: [],
        emptyMessage: "Nothing available.",
      }),
    ).toBeUndefined();
    expect(printed).toEqual(["Nothing available."]);
    expect(prompted).toBeFalse();
  });
});
