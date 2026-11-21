/** v13 permits RunLog's fixed lifecycle words; author text stays in the source guard. */
export function withoutRunLogLifecycle(markup: string): string {
  const selector = '.k2b-run-log__main, .k2b-run-log__head > .k2b-sr-only[role="status"]';
  const words: string[] = [];
  new HTMLRewriter()
    .on(selector, {
      element() {
        words.push("");
      },
      text(chunk) {
        words[words.length - 1] += chunk.text;
      },
    })
    .transform(markup);
  const fixed =
    /^(?:Noch nicht ausgeführt|Startet …|Läuft|Fertig|Gescheitert|Not run yet|Starting …|Running|Done|Failed|(?:Läuft seit|Fertig nach|Gescheitert nach|Running for|Done in|Failed after) \d+:\d{2})$/;
  for (const word of words) if (!fixed.test(word.trim())) throw new Error(`Unexpected RunLog lifecycle text: ${word}`);
  return new HTMLRewriter()
    .on(selector, {
      element(element) {
        element.remove();
      },
    })
    .transform(markup);
}
