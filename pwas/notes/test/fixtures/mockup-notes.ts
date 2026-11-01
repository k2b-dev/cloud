/** The fictional notes of mockup v4, for browser tests and screenshots. Times are fixed relative to `now`. */
export const mockupNotes = (now: number) => {
  const hours = (count: number) => now - count * 3_600_000;
  const days = (count: number) => now - count * 86_400_000;
  const id = (name: string) => name.padEnd(22, "0").slice(0, 22);
  return [
    {
      id: id("lauf"),
      updatedAt: hours(2),
      text: "# Lauftraining Herbst\n#sport\n\nZiel ist der **Halbmarathon im April**. Bis Weihnachten baue ich die Grundlage auf, danach kommt Tempo dazu.\n\n## Wochenplan\n\n- Dienstag: 6 × 800 m, dazwischen 2 Minuten Trab\n- Donnerstag: 45 Minuten locker\n- Sonntag: lange Runde, jede Woche 1 km mehr\n\n:::chart\ntype: area\ntitle: Kilometer pro Woche\ncolumns: [Woche, km]\nrows:\n  - [KW 36, 18]\n  - [KW 37, 22]\n  - [KW 38, 21]\n  - [KW 39, 26]\n  - [KW 40, 24]\n  - [KW 41, 30]\n  - [KW 42, 28]\n  - [KW 43, 34]\nx: Woche\ny: km\n:::\n\n## Diese Woche\n\n- [x] Neue Schuhe einlaufen\n- [ ] Intervalle am Dienstag\n- [ ] Sonntag 16 km **vor dem Frühstück**\n",
    },
    {
      id: id("lissabon"),
      updatedAt: days(1),
      share: { kind: "own" as const, readId: id("r7Hq2VxLp9Ka4cTn3Wd8Ze"), editId: id("w3Nf8ZbYe1Qm6dRk5Ts2Lu"), sharedAt: days(3) },
      text: "# Lissabon im März\n#reise\n\nAlfama am ersten Abend, LX Factory am Sonntag, Tram 28 lieber früh morgens.\n\n## Pläne\n\n- Alfama am ersten Abend, Fado nur, wenn wir nicht zu müde sind\n- LX Factory am Sonntag\n- Tram 28 lieber früh morgens\n",
    },
    {
      id: id("verein"),
      updatedAt: days(1) - 3_600_000,
      share: {
        kind: "foreign" as const,
        role: "edit" as const,
        linkId: id("g8Kd2LmQ4xWn7ZtR1bYc5H"),
        readId: id("h2Pq9VnC3sLm8KxT4dWz6J"),
        addedAt: days(9),
      },
      text: "# Gartenverein – Treffen 4. November\n#verein\n\nTagesordnung: Wasseruhren, Laubsammlung, neue Beete hinten links.\n\n## Tagesordnung\n\n- Wasseruhren ablesen bis Ende November\n- Laubsammlung am Samstag, Container steht am Tor\n",
    },
    {
      id: id("shakshuka"),
      updatedAt: days(3),
      text: "# Shakshuka für vier\n#rezepte\n\n6 Eier, 2 Dosen Tomaten, Paprika, Kreuzkümmel, Feta zum Schluss.\n",
    },
    {
      id: id("nebenkosten"),
      updatedAt: days(6),
      text: "# Nebenkosten 2026\n#finanzen\n\nStrom und Heizung pro Monat, Abschlag ab Januar anpassen.\n\n| Monat | Euro |\n| --- | ---: |\n| Jan | 92 |\n| Feb | 88 |\n| Mär | 81 |\n| Apr | 64 |\n| Mai | 52 |\n| Jun | 47 |\n| Jul | 49 |\n| Aug | 58 |\n| Sep | 71 |\n| Okt | 86 |\n",
    },
    {
      id: id("geschenk"),
      updatedAt: days(9),
      text: "# Ideen für Leas Geburtstag\n#ideen\n\nTöpferkurs, Konzertkarten, das Buch über Pilze, Picknick am See.\n",
    },
    {
      id: id("satzung"),
      updatedAt: days(12),
      share: {
        kind: "foreign" as const,
        role: "read" as const,
        linkId: id("s5Tn1QwE8rYu3IoP6aSd9F"),
        readId: id("s5Tn1QwE8rYu3IoP6aSd9F"),
        addedAt: days(12),
      },
      text: "# Satzungsentwurf\n#verein\n\n## § 3 Mitgliedschaft\n\nMitglied kann jede natürliche Person werden, die die Ziele des Vereins unterstützt.\n",
    },
    {
      id: id("lesestapel"),
      updatedAt: days(28),
      text: "# Lesestapel\n#lesen #ideen\n\nDie Wellenlänge des Lichts, Kairos, Der Halbbart, Tomorrow ×3.\n",
    },
    {
      id: id("brot"),
      updatedAt: days(31),
      text: "# Sauerteig – Notizen\n#rezepte\n\nAnstellgut 1:5:5, 12 Stunden. Beim zweiten Versuch mehr Wasser.\n",
    },
  ];
};
