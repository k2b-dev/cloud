// ==========================
// Built-in page templates: short pages every notebook offers, in English and German.
// `{{date}}` and `{{author}}` are filled in when a page is made.
// ==========================

type Localized = { name: string; description: string; content: string };

export type BuiltInPageTemplate = {
  id: string;
  icon: string;
  en: Localized;
  de: Localized;
};

export const builtInPageTemplates: readonly BuiltInPageTemplate[] = [
  {
    id: "meeting-notes",
    icon: "ti ti-users",
    en: {
      name: "Meeting notes",
      description: "Agenda, decisions and action items",
      content: `# Meeting {{date}}

- **Date:** {{date}}
- **Notes by:** {{author}}
- **Participants:**

## Agenda

1.

## Notes

## Decisions

| Decision | Owner | Due |
| --- | --- | --- |
|  |  |  |

## Action items

- [ ]\u0020
`,
    },
    de: {
      name: "Besprechungsprotokoll",
      description: "Tagesordnung, Beschlüsse und Aufgaben",
      content: `# Besprechung {{date}}

- **Datum:** {{date}}
- **Protokoll:** {{author}}
- **Teilnehmende:**

## Tagesordnung

1.

## Notizen

## Beschlüsse

| Beschluss | Verantwortlich | Bis |
| --- | --- | --- |
|  |  |  |

## Aufgaben

- [ ]\u0020
`,
    },
  },
  {
    id: "project-page",
    icon: "ti ti-rocket",
    en: {
      name: "Project page",
      description: "Goal, milestones and open questions",
      content: `# Project: Name

- **Owner:** {{author}}
- **Start:** {{date}}
- **Status:** Planned

## Goal

What should be true at the end, and how will we know?

## Milestones

| Milestone | Date | Status |
| --- | --- | --- |
|  |  | Open |

## Tasks

- [ ]\u0020

## Open questions

## Links
`,
    },
    de: {
      name: "Projektseite",
      description: "Ziel, Meilensteine und offene Fragen",
      content: `# Projekt: Name

- **Verantwortlich:** {{author}}
- **Start:** {{date}}
- **Status:** Geplant

## Ziel

Was soll am Ende erreicht sein, und woran erkennen wir es?

## Meilensteine

| Meilenstein | Termin | Status |
| --- | --- | --- |
|  |  | Offen |

## Aufgaben

- [ ]\u0020

## Offene Fragen

## Links
`,
    },
  },
  {
    id: "decision-record",
    icon: "ti ti-scale",
    en: {
      name: "Decision",
      description: "Context, options and consequences",
      content: `# Decision: Topic

- **Date:** {{date}}
- **Written by:** {{author}}
- **Status:** Proposed

## Context

What is the problem, and why do we decide now?

## Options

| Option | Pros | Cons |
| --- | --- | --- |
| A |  |  |
| B |  |  |

## Decision

We choose …, because …

## Consequences

- [ ]\u0020
`,
    },
    de: {
      name: "Entscheidung",
      description: "Ausgangslage, Optionen und Folgen",
      content: `# Entscheidung: Thema

- **Datum:** {{date}}
- **Verfasst von:** {{author}}
- **Status:** Vorgeschlagen

## Ausgangslage

Was ist das Problem, und warum entscheiden wir jetzt?

## Optionen

| Option | Vorteile | Nachteile |
| --- | --- | --- |
| A |  |  |
| B |  |  |

## Entscheidung

Wir entscheiden uns für …, weil …

## Folgen

- [ ]\u0020
`,
    },
  },
];

const languageOf = (locale: string | undefined): "en" | "de" => (locale?.toLowerCase().startsWith("de") ? "de" : "en");

export const localizedBuiltInPageTemplate = (template: BuiltInPageTemplate, locale: string | undefined): Localized =>
  template[languageOf(locale)];

export const findBuiltInPageTemplate = (id: string): BuiltInPageTemplate | null =>
  builtInPageTemplates.find((template) => template.id === id) ?? null;
