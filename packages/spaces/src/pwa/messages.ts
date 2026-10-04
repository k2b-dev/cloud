import { i18n } from "@k2b/stdlib";

/** Strings of the mobile app's "My tasks" page that the web overview does not have. */
export const myTasksMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      tasks: "Tasks",
      complete: ({ title }: { title: string }) => `Mark “${title}” as done`,
      completing: ({ title }: { title: string }) => `Marking “${title}” as done`,
      event: "Event",
      done: "Done",
      undo: "Undo",
      completeFailed: ({ title }: { title: string }) => `“${title}” could not be marked as done.`,
      reopenFailed: ({ title }: { title: string }) => `“${title}” could not be reopened.`,
      refreshFailed: "The list could not be updated.",
      claimed: ({ title, name }: { title: string; name: string }) =>
        `${name} is working on “${title}”. Take it over in Spaces on the web to finish it.`,
      notAllowed: ({ space }: { space: string }) => `You cannot change tasks in “${space}”.`,
      gone: ({ title }: { title: string }) => `“${title}” is no longer available.`,
      allDay: "All day",
      more: ({ count }: { count: string }) => `${count} more in Spaces on the web`,
    },
    de: {
      tasks: "Aufgaben",
      complete: ({ title }) => `„${title}“ als erledigt markieren`,
      completing: ({ title }) => `„${title}“ wird als erledigt markiert`,
      event: "Termin",
      done: "Erledigt",
      undo: "Rückgängig",
      completeFailed: ({ title }) => `„${title}“ konnte nicht als erledigt markiert werden.`,
      reopenFailed: ({ title }) => `„${title}“ konnte nicht wieder geöffnet werden.`,
      refreshFailed: "Die Liste konnte nicht aktualisiert werden.",
      claimed: ({ title, name }) => `${name} arbeitet an „${title}“. Übernimm die Aufgabe in Spaces im Web, um sie abzuschließen.`,
      notAllowed: ({ space }) => `Du kannst in „${space}“ keine Aufgaben ändern.`,
      gone: ({ title }) => `„${title}“ ist nicht mehr verfügbar.`,
      allDay: "Ganztägig",
      more: ({ count }) => `${count} weitere in Spaces im Web`,
    },
  },
});
