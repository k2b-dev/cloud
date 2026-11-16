import { expect, test } from "bun:test";
import { aiChatMessages } from "./messages";
import { aiThinkingWordRound, aiThinkingWords } from "./thinking-words";

for (const locale of ["de", "en"]) {
  const t = aiChatMessages(locale);
  const words = aiThinkingWords(locale);
  const winks = new Set([...words.wink, ...words.moustache]);

  test(`${locale}: the catalog holds the 19 approved words after "${t.thinking}"`, () => {
    expect([words.plain.length, words.wink.length, words.moustache.length]).toEqual([11, 6, 2]);
    expect(t.stepThinking).toBe(t.thinking);
    expect(t.thinkingAnnouncement).toBe(locale === "de" ? "Gustav denkt nach" : "Gustav is thinking");
  });

  test(`${locale}: every round starts plain, never shows two winks in a row and splits the moustaches`, () => {
    for (let seed = 0; seed < 200; seed++) {
      const id = `turn-${seed}:thinking`;
      const round = aiThinkingWordRound(id, words);
      expect(round).toHaveLength(19);
      expect(new Set(round).size).toBe(19);
      expect(winks.has(round[0]!) || winks.has(round[1]!)).toBe(false);
      // The round repeats, so its end meets its start too.
      for (let index = 0; index < round.length; index++)
        expect(winks.has(round[index]!) && winks.has(round[(index + 1) % round.length]!), `${id} at ${index}`).toBe(false);
      const [early, late] = words.moustache.map((word) => round.indexOf(word));
      expect(early! < round.length / 2 !== late! < round.length / 2, id).toBe(true);
      // Same id, same round: the server and the browser agree.
      expect(aiThinkingWordRound(id, words)).toEqual(round);
    }
  });
}
