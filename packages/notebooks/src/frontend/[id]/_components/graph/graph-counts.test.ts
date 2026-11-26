import { expect, test } from "bun:test";
import { notebookWorkspaceMessages } from "../../messages";

// A notebook of 1,000 notes and 1,571 links (the worst-case fixture) must not read "1571 Verknüpfungen".
test("the graph's counts group their digits in the reader's language and say one in the singular", () => {
  const de = notebookWorkspaceMessages.resolve(["de"]).t;
  const en = notebookWorkspaceMessages.resolve(["en"]).t;
  expect(de.graphFigureLinks({ count: 1571 })).toBe("1.571 Verknüpfungen");
  expect(de.graphFigureNotes({ notes: 1000, areas: 9 })).toBe("zwischen 1.000 Notizen in 9 Bereichen");
  expect(de.graphFigureUnlinked({ count: 1200 })).toBe("1.200 ohne Verknüpfung");
  expect(de.graphListCount({ notes: 1000 })).toBe("1.000 Notizen");
  expect(de.graphNoteCount({ notes: 1000, links: 1571 })).toBe("1.000 Notizen · 1.571 Verknüpfungen");
  expect(en.graphFigureLinks({ count: 1571 })).toBe("1,571 links");
  expect(en.graphFigureLinks({ count: 1 })).toBe("1 link");
  expect(en.graphFigureNotes({ notes: 3, areas: 1 })).toBe("between 3 notes");
  expect(en.graphListCountScoped({ notes: 1200, total: 20_000 })).toBe("1,200 of 20,000 notes");
});
