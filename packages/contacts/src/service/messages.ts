import { i18n, type ServiceError } from "@k2b/stdlib";

/**
 * Human-facing messages for the Contacts service and API boundary.
 *
 * The English base reproduces the exact copy these seams already ship; German
 * is complete. Stable error `code`/`status` values never change with locale,
 * and callers must branch on codes, never on translated text.
 *
 * Seam contract: boundaries resolve the request locale once (`getLocale(c)`
 * for Hono handlers, `context.locale` for capabilities) and pass it as the
 * optional `locale` field on the service call's config object. Service
 * functions resolve `t` once per call via `contactsMessages(locale)`.
 */
const catalog = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      // Not found (full messages; stdlib err.notFound composes English only)
      bookNotFound: "Book not found",
      bookOrAccessEntryNotFound: "Book or access entry not found",
      accessEntryNotFound: "Access entry for this book not found",
      contactNotFound: "Contact not found",
      contactsNotFound: "One or more contacts not found",
      contactOrTagNotFound: "Contact or tag not found",
      parentContactOrTagNotFound: "Parent contact or tag not found",
      contactParentOrTagNotFound: "Contact, parent contact, or tag not found",
      contactNoteNotFound: "Contact note not found",
      contactTreeNotFound: "Contact tree not found",
      noteNotFound: "Note not found",
      tagNotFound: "Tag not found",
      apiKeyNotFound: "API key not found",

      // Conflicts
      bookAccessEntryExists: "Book access entry already exists",
      principalAlreadyHasAccess: "This principal already has access to this book",
      tagNameExists: "Tag with that name already exists",
      contactChanged: "Contact changed since it was read",
      contactsChangedWhileMerging: "Contacts changed while merging; review them again",
      idempotencyKeyReused: "Idempotency-Key was already used with different input",
      idempotentNoteGone: "The note created by this idempotency key no longer exists",

      // Bad input
      chooseAtLeastOneContact: "Choose at least one contact",
      chooseAtLeastOneTag: "Choose at least one tag",
      chooseAnotherBook: "Choose another contact book",
      chooseTwoDifferentContacts: "Choose two different contacts",
      contactIdsMustBeUuids: "Contact ids must be UUIDs",
      parentIdMustBeUuid: "Parent contact id must be a UUID",
      contactOwnParent: "A contact cannot be its own parent",
      parentContactMissing: "Parent contact does not exist",
      parentSameBook: "Parent must live in the same book",
      hierarchyCycle: "Cannot create a hierarchy cycle",
      lastAccessEntry: "Cannot remove the last access entry",
      lastAdmin: "Cannot remove the last admin",
      noteContentRequired: "Note content is required",
      noteTooLong: ({ max }: { max: number }) => `Note must be ${max} characters or fewer`,
      tagNameRequired: "Tag name is required",
      tagNameTooLong: "Tag name must be 50 characters or fewer",
      tagColorInvalid: "Tag color must be a #RRGGBB hex value",
      tagIdsMustBeUuids: "Tag ids must be UUIDs",
      tagsNotInBook: "One or more tags do not belong to this book",
      tagAddRemoveConflict: "A tag cannot be added and removed in the same change",
      importLimit: ({ max }: { max: number }) => `Import is limited to ${max} contacts at a time`,
      importNeedsContentLength: "Import request requires Content-Length",
      invalidContentLength: "Invalid Content-Length",
      importTooLarge: "Import request is too large",
      invalidResolveCursor: "Invalid contact resolution cursor",

      // Forbidden
      accessDenied: "Access denied",
      endpointNeedsUser: "This endpoint requires a user-backed actor",
      favoritesNeedUser: "Favorites require a user-backed actor",
      notesNeedUser: "A user identity is required to create notes",
      noteEditAuthorOnly: "Only the author may edit this note",
      noteDeleteAuthorOnly: "Only the author may delete this note",
      noteEditWindow: "Notes can only be edited within 10 minutes",
      noteDeleteWindow: "Notes can only be deleted within 10 minutes",

      // WebSocket live updates
      loginRequired: "Login required",
      contactBookNotFound: "Contact book not found",
      liveBackpressure: "Live updates exceeded the connection capacity",
      liveAccessRefreshFailed: "Access refresh failed",
      liveStreamFailed: "Contact event stream failed",
      invalidJson: "Invalid JSON payload",
      invalidLiveSubscription: "Invalid live subscription",
      liveSubscriptionActive: "A live subscription is already active",
      tooManyLiveMessages: "Too many pending live messages",
      liveSubscriptionFailed: "Live subscription failed",

      invalidRequest: "The Contacts request is invalid",
      resourceNotFound: "The requested Contacts resource was not found",
      conflictingChange: "The Contacts change conflicts with the current state",
      operationFailed: "The Contacts operation failed",

      // Success messages
      accessUpdated: "Access updated",
      accessRevoked: "Access revoked",
      favoriteUpdated: "Favorite state updated",
      bookDeleted: "Book deleted",
      contactDeleted: "Contact deleted",
      noteDeleted: "Note deleted",
      tagDeleted: "Tag deleted",
      apiKeyRevoked: "API key revoked.",
    },
    de: {
      bookNotFound: "Das Kontaktbuch wurde nicht gefunden",
      bookOrAccessEntryNotFound: "Das Kontaktbuch oder der Zugriffseintrag wurde nicht gefunden",
      accessEntryNotFound: "Für dieses Kontaktbuch wurde kein passender Zugriffseintrag gefunden",
      contactNotFound: "Der Kontakt wurde nicht gefunden",
      contactsNotFound: "Mindestens ein Kontakt wurde nicht gefunden",
      contactOrTagNotFound: "Der Kontakt oder der Tag wurde nicht gefunden",
      parentContactOrTagNotFound: "Der übergeordnete Kontakt oder der Tag wurde nicht gefunden",
      contactParentOrTagNotFound: "Der Kontakt, der übergeordnete Kontakt oder der Tag wurde nicht gefunden",
      contactNoteNotFound: "Der Kommentar wurde nicht gefunden",
      contactTreeNotFound: "Die Kontakthierarchie wurde nicht gefunden",
      noteNotFound: "Der Kommentar wurde nicht gefunden",
      tagNotFound: "Der Tag wurde nicht gefunden",
      apiKeyNotFound: "Der API-Schlüssel wurde nicht gefunden",

      bookAccessEntryExists: "Dieser Zugriffseintrag existiert bereits",
      principalAlreadyHasAccess: "Dieser Zugriff besteht für dieses Kontaktbuch bereits",
      tagNameExists: "Ein Tag mit diesem Namen existiert bereits",
      contactChanged: "Der Kontakt wurde inzwischen geändert; lade ihn neu",
      contactsChangedWhileMerging: "Die Kontakte wurden während des Zusammenführens geändert; prüfe sie erneut",
      idempotencyKeyReused: "Der Idempotency-Key wurde bereits mit anderen Eingaben verwendet",
      idempotentNoteGone: "Der mit diesem Idempotency-Key erstellte Kommentar existiert nicht mehr",

      chooseAtLeastOneContact: "Wähle mindestens einen Kontakt",
      chooseAtLeastOneTag: "Wähle mindestens einen Tag",
      chooseAnotherBook: "Wähle ein anderes Kontaktbuch",
      chooseTwoDifferentContacts: "Wähle zwei unterschiedliche Kontakte",
      contactIdsMustBeUuids: "Kontakt-IDs müssen gültige UUIDs sein",
      parentIdMustBeUuid: "Die ID des übergeordneten Kontakts muss eine UUID sein",
      contactOwnParent: "Ein Kontakt kann nicht sein eigener übergeordneter Kontakt sein",
      parentContactMissing: "Der übergeordnete Kontakt existiert nicht",
      parentSameBook: "Der übergeordnete Kontakt muss im selben Kontaktbuch liegen",
      hierarchyCycle: "Diese Zuordnung würde einen Zyklus in der Hierarchie erzeugen",
      lastAccessEntry: "Der letzte Zugriffseintrag kann nicht entfernt werden",
      lastAdmin: "Die letzte Person mit Administratorrechten kann nicht entfernt werden",
      noteContentRequired: "Der Kommentar darf nicht leer sein",
      noteTooLong: ({ max }) => `Der Kommentar darf höchstens ${max} Zeichen lang sein`,
      tagNameRequired: "Gib einen Namen für den Tag ein",
      tagNameTooLong: "Der Tagname darf höchstens 50 Zeichen lang sein",
      tagColorInvalid: "Die Tagfarbe muss ein Hex-Wert im Format #RRGGBB sein",
      tagIdsMustBeUuids: "Tag-IDs müssen UUIDs sein",
      tagsNotInBook: "Mindestens ein Tag gehört nicht zu diesem Kontaktbuch",
      tagAddRemoveConflict: "Ein Tag kann nicht in derselben Änderung hinzugefügt und entfernt werden",
      importLimit: ({ max }) => `Der Import ist auf ${max} Kontakte pro Durchlauf begrenzt`,
      importNeedsContentLength: "Die Import-Anfrage benötigt einen Content-Length-Header",
      invalidContentLength: "Der Content-Length-Header ist ungültig",
      importTooLarge: "Die Import-Anfrage ist zu groß",
      invalidResolveCursor: "Der Cursor für die Kontaktauflösung ist ungültig",

      accessDenied: "Du hast keinen Zugriff",
      endpointNeedsUser: "Für diesen Endpunkt ist ein Benutzerkonto erforderlich",
      favoritesNeedUser: "Für Favoriten ist ein Benutzerkonto erforderlich",
      notesNeedUser: "Zum Erstellen von Kommentaren ist ein Benutzerkonto erforderlich",
      noteEditAuthorOnly: "Nur die Person, die den Kommentar verfasst hat, kann ihn bearbeiten",
      noteDeleteAuthorOnly: "Nur die Person, die den Kommentar verfasst hat, kann ihn löschen",
      noteEditWindow: "Kommentare können nur innerhalb von 10 Minuten bearbeitet werden",
      noteDeleteWindow: "Kommentare können nur innerhalb von 10 Minuten gelöscht werden",

      loginRequired: "Anmeldung erforderlich",
      contactBookNotFound: "Das Kontaktbuch wurde nicht gefunden",
      liveBackpressure: "Die Live-Updates haben die Kapazität der Verbindung überschritten",
      liveAccessRefreshFailed: "Die Zugriffsprüfung ist fehlgeschlagen",
      liveStreamFailed: "Der Kontakt-Ereignisstrom ist fehlgeschlagen",
      invalidJson: "Die JSON-Daten sind ungültig",
      invalidLiveSubscription: "Die Live-Anmeldung ist ungültig",
      liveSubscriptionActive: "Eine Live-Anmeldung ist bereits aktiv",
      tooManyLiveMessages: "Zu viele ausstehende Live-Nachrichten",
      liveSubscriptionFailed: "Die Live-Anmeldung ist fehlgeschlagen",

      invalidRequest: "Die Contacts-Anfrage ist ungültig",
      resourceNotFound: "Die angeforderte Contacts-Ressource wurde nicht gefunden",
      conflictingChange: "Die Contacts-Änderung steht im Konflikt mit dem aktuellen Stand",
      operationFailed: "Der Contacts-Vorgang ist fehlgeschlagen",

      accessUpdated: "Zugriff aktualisiert",
      accessRevoked: "Zugriff entzogen",
      favoriteUpdated: "Favorit aktualisiert",
      bookDeleted: "Kontaktbuch gelöscht",
      contactDeleted: "Kontakt gelöscht",
      noteDeleted: "Kommentar gelöscht",
      tagDeleted: "Tag gelöscht",
      apiKeyRevoked: "API-Schlüssel widerrufen",
    },
  },
});

export type ContactsMessages = ReturnType<(typeof catalog)["resolve"]>["t"];

/** Resolves the service message set for one call. Falls back to English. */
export const contactsMessages = (locale?: string | null): ContactsMessages => catalog.resolve(locale ? [locale] : []).t;

export const checkContactsMessages = () => catalog.check();

export const contactsApiErrorMessage = (status: number, locale?: string | null, baseMessage?: string): string => {
  const resolved = catalog.resolve(locale ? [locale] : []);
  if (resolved.locale === "en" && baseMessage) return baseMessage;
  const { t } = resolved;
  if (status === 401) return t.loginRequired;
  if (status === 403) return t.accessDenied;
  if (status === 404) return t.resourceNotFound;
  if (status === 409) return t.conflictingChange;
  if (status >= 500) return t.operationFailed;
  return t.invalidRequest;
};

/**
 * Full-message error constructors. `err.notFound`/`err.conflict` compose an
 * English suffix around a label, so localized messages must be passed whole.
 */
export const notFoundError = (message: string): ServiceError => ({ code: "NOT_FOUND", message, status: 404 });
export const conflictError = (message: string): ServiceError => ({ code: "CONFLICT", message, status: 409 });
