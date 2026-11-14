import { expect, test } from "bun:test";
import { checkNextMessageEval, NEXT_MESSAGE_EVAL_CASES } from "./next-message.eval";

test("fifteen frozen fixtures retain the approved groups and privacy traps", () => {
  expect(NEXT_MESSAGE_EVAL_CASES.map((item) => item.id)).toEqual([
    "J1",
    "J2",
    "J3",
    "J4",
    "J5",
    "N1",
    "N2",
    "N3",
    "N4",
    "N5",
    "N6",
    "N7",
    "N8",
    "N9",
    "N10",
  ]);
  expect(checkNextMessageEval(NEXT_MESSAGE_EVAL_CASES[0]!, "Ja, entwirf die Antwort an Jana").problems).toEqual([]);
  expect(checkNextMessageEval(NEXT_MESSAGE_EVAL_CASES[7]!, "Ja, antworte Jana").text).toBeNull();
  expect(checkNextMessageEval(NEXT_MESSAGE_EVAL_CASES[9]!, "Ja, sende den Entwurf").text).toBeNull();
});
test("automatic checks catch language, repetition, invented names and unseen tool data", () => {
  const n8 = NEXT_MESSAGE_EVAL_CASES[12]!;
  expect(checkNextMessageEval(n8, "Fass die Mail zusammen!").problems).toContain("repetition");
  const n9 = NEXT_MESSAGE_EVAL_CASES[13]!;
  expect(checkNextMessageEval(n9, "Ja, ruf Jana unter +49 30 5550182 an").problems).toContain("private_data:+49 30 5550182");
  expect(checkNextMessageEval(n9, "Ja, ruf Yara an").problems).toContain("name:Yara");
  expect(checkNextMessageEval(n9, "Ja, ruf Petra an").problems).toContain("name:Petra");
  expect(checkNextMessageEval(n9, "Ja, ruf Jan an").problems).toContain("name:Jan");
  expect(checkNextMessageEval(n9, "Ja, lass Jana anrufen").problems).toEqual([]);
  expect(checkNextMessageEval(NEXT_MESSAGE_EVAL_CASES[14]!, "Yes, draft the reply").problems).toContain("language");
  expect(checkNextMessageEval(NEXT_MESSAGE_EVAL_CASES[0]!, "Ja ".repeat(50)).problems).toContain("length");
});
