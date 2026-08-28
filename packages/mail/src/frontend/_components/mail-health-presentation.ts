import { i18n } from "@k2b/stdlib";
import type { Mailbox, MailboxHealth, MailboxOperationalHealth } from "../../contracts";

type MailboxHealthPresentation = {
  title: string;
  message: string;
  tone: "info" | "warning";
  action: "health" | "delivery" | null;
  actionLabel: string | null;
};

const timedOut = (reason: string | null): boolean =>
  reason?.toLowerCase().includes("failed to establish connection in required time") === true;

const healthMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      pausedTitle: "Mail sync is paused",
      pausedMessage: "New mail will not appear until synchronization is resumed.",
      resumeSync: "Resume sync",
      timeoutTitle: "Mail is taking longer to connect",
      timeoutMessage: "The saved account is valid, but the latest synchronization timed out. Mail will retry automatically.",
      degradedTitle: "Mail could not synchronize",
      degradedMessage: "The saved account is still connected. Review the connection status for details and recovery actions.",
      viewStatus: "View status",
      authTitle: "Mail needs you to sign in again",
      authMessage: "Reconnect the account before new messages can be synchronized or sent.",
      reconnectAccount: "Reconnect account",
      connectTitle: "Connect a mail account",
      connectionRequiredMessage: "This mailbox has no usable provider connection.",
      disconnectedMessage: "This mailbox is not connected to a mail provider yet.",
      openDeliverySettings: "Open delivery settings",
      verifyingTitle: "Checking the mail account",
      verifyingMessage: "Mail is verifying the provider connection. This usually takes only a moment.",
      bootstrappingTitle: "Mail is finishing setup",
      bootstrappingMessage: "Messages are being synchronized for the first time and may appear gradually.",
      reconnectingTitle: "Mail is reconnecting",
      reconnectingMessage: "New messages may take a moment to appear while the provider connection recovers.",
      connectedAccounts: ({ count }: { count: number }) => `${count} connected account${count === 1 ? "" : "s"}`,
      degradedAccounts: ({ count }: { count: number }) => `${count} degraded account${count === 1 ? "" : "s"}`,
      pendingAccounts: ({ count }: { count: number }) => `${count} ${count === 1 ? "account" : "accounts"} pending`,
      noConnectedAccount: "No connected account",
      discoveredFolders: ({ count }: { count: number }) => `${count} discovered folder${count === 1 ? "" : "s"}`,
      foldersNeedReview: ({ count }: { count: number }) => `${count} ${count === 1 ? "needs" : "need"} review`,
      synchronizationsRunning: ({ count }: { count: number }) => `${count} synchronization${count === 1 ? "" : "s"} running`,
      degradedFolders: ({ count }: { count: number }) => `${count} degraded folder${count === 1 ? "" : "s"}`,
      currentFolders: ({ count }: { count: number }) => `${count} current folder${count === 1 ? "" : "s"}`,
      rebuildingFolders: ({ count }: { count: number }) => `${count} folder${count === 1 ? "" : "s"} rebuilding`,
      synchronizingFolders: ({ count }: { count: number }) => `${count} folder${count === 1 ? "" : "s"} synchronizing`,
      pendingFolders: ({ count }: { count: number }) => `${count} folder${count === 1 ? "" : "s"} pending`,
      noSynchronizedFolders: "No synchronized folders",
      searchAdvanced: "Search available · advanced",
      searchStandard: "Search available · standard",
      justNow: "just now",
      noReceivingAddress: "No receiving address configured",
    },
    de: {
      pausedTitle: "E-Mail-Synchronisierung ist pausiert",
      pausedMessage: "Neue E-Mails erscheinen erst, wenn die Synchronisierung fortgesetzt wird.",
      resumeSync: "Synchronisierung fortsetzen",
      timeoutTitle: "Die Verbindung dauert länger als erwartet",
      timeoutMessage:
        "Das gespeicherte Konto ist gültig, aber die letzte Synchronisierung ist abgelaufen. Mail versucht es automatisch erneut.",
      degradedTitle: "E-Mails konnten nicht synchronisiert werden",
      degradedMessage: "Das gespeicherte Konto ist weiterhin verbunden. Prüfe den Verbindungsstatus für Details und mögliche Maßnahmen.",
      viewStatus: "Status anzeigen",
      authTitle: "Erneute Anmeldung erforderlich",
      authMessage: "Verbinde das Konto erneut, bevor neue Nachrichten synchronisiert oder gesendet werden können.",
      reconnectAccount: "Konto erneut verbinden",
      connectTitle: "E-Mail-Konto verbinden",
      connectionRequiredMessage: "Dieses Postfach hat keine verwendbare Anbieterverbindung.",
      disconnectedMessage: "Dieses Postfach ist noch nicht mit einem E-Mail-Anbieter verbunden.",
      openDeliverySettings: "Versandeinstellungen öffnen",
      verifyingTitle: "E-Mail-Konto wird geprüft",
      verifyingMessage: "Mail prüft die Anbieterverbindung. Das dauert normalerweise nur einen Moment.",
      bootstrappingTitle: "Mail schließt die Einrichtung ab",
      bootstrappingMessage: "Nachrichten werden erstmals synchronisiert und können nach und nach erscheinen.",
      reconnectingTitle: "Mail stellt die Verbindung wieder her",
      reconnectingMessage: "Neue Nachrichten können kurz verzögert erscheinen, während die Anbieterverbindung wiederhergestellt wird.",
      connectedAccounts: ({ count }) => `${count} ${count === 1 ? "verbundenes Konto" : "verbundene Konten"}`,
      degradedAccounts: ({ count }) => `${count} ${count === 1 ? "beeinträchtigtes Konto" : "beeinträchtigte Konten"}`,
      pendingAccounts: ({ count }) => `${count} ${count === 1 ? "ausstehendes Konto" : "ausstehende Konten"}`,
      noConnectedAccount: "Kein verbundenes Konto",
      discoveredFolders: ({ count }) => `${count} ${count === 1 ? "erkannter Ordner" : "erkannte Ordner"}`,
      foldersNeedReview: ({ count }) => `${count} ${count === 1 ? "muss" : "müssen"} geprüft werden`,
      synchronizationsRunning: ({ count }) => `${count} ${count === 1 ? "Synchronisierung läuft" : "Synchronisierungen laufen"}`,
      degradedFolders: ({ count }) => `${count} ${count === 1 ? "beeinträchtigter Ordner" : "beeinträchtigte Ordner"}`,
      currentFolders: ({ count }) => `${count} ${count === 1 ? "aktueller Ordner" : "aktuelle Ordner"}`,
      rebuildingFolders: ({ count }) => `${count} ${count === 1 ? "Ordner wird" : "Ordner werden"} neu aufgebaut`,
      synchronizingFolders: ({ count }) => `${count} ${count === 1 ? "Ordner wird" : "Ordner werden"} synchronisiert`,
      pendingFolders: ({ count }) => `${count} ${count === 1 ? "Ordner ausstehend" : "Ordner ausstehend"}`,
      noSynchronizedFolders: "Keine synchronisierten Ordner",
      searchAdvanced: "Suche verfügbar · erweitert",
      searchStandard: "Suche verfügbar · standard",
      justNow: "gerade eben",
      noReceivingAddress: "Keine Empfangsadresse konfiguriert",
    },
  },
});

export const mailboxHealthPresentation = (
  mailbox: Pick<Mailbox, "health" | "healthReason">,
  locale = "en",
): MailboxHealthPresentation | null => {
  const t = healthMessages.resolve([locale]).t;
  const presentations: Record<MailboxHealth, MailboxHealthPresentation | null> = {
    active: null,
    paused: {
      title: t.pausedTitle,
      message: t.pausedMessage,
      tone: "warning",
      action: "health",
      actionLabel: t.resumeSync,
    },
    degraded: timedOut(mailbox.healthReason)
      ? {
          title: t.timeoutTitle,
          message: t.timeoutMessage,
          tone: "warning",
          action: "health",
          actionLabel: t.viewStatus,
        }
      : {
          title: t.degradedTitle,
          message: t.degradedMessage,
          tone: "warning",
          action: "health",
          actionLabel: t.viewStatus,
        },
    auth_required: {
      title: t.authTitle,
      message: t.authMessage,
      tone: "warning",
      action: "delivery",
      actionLabel: t.reconnectAccount,
    },
    connection_required: {
      title: t.connectTitle,
      message: t.connectionRequiredMessage,
      tone: "warning",
      action: "delivery",
      actionLabel: t.openDeliverySettings,
    },
    disconnected: {
      title: t.connectTitle,
      message: t.disconnectedMessage,
      tone: "warning",
      action: "delivery",
      actionLabel: t.openDeliverySettings,
    },
    verifying: {
      title: t.verifyingTitle,
      message: t.verifyingMessage,
      tone: "info",
      action: "health",
      actionLabel: t.viewStatus,
    },
    bootstrapping: {
      title: t.bootstrappingTitle,
      message: t.bootstrappingMessage,
      tone: "info",
      action: "health",
      actionLabel: t.viewStatus,
    },
    reconnecting: {
      title: t.reconnectingTitle,
      message: t.reconnectingMessage,
      tone: "info",
      action: "health",
      actionLabel: t.viewStatus,
    },
  };
  return presentations[mailbox.health];
};

export const mailboxOperationalHealthSummary = (
  health: MailboxOperationalHealth,
  locale = "en",
): { accounts: string; discovery: string; synchronization: string; search: string } => {
  const t = healthMessages.resolve([locale]).t;
  const reviewCount = health.discovery.missingFolders + health.discovery.ambiguousFolders;
  const degradedFolders = health.sync.folderStates.degraded ?? 0;
  const currentFolders = health.sync.folderStates.current ?? 0;
  const rebuildingFolders = health.sync.folderStates.rebuilding ?? 0;
  const syncingFolders = health.sync.folderStates.syncing ?? 0;
  const pendingFolders = health.sync.folderStates.pending ?? 0;

  const accounts =
    health.bindings.degraded > 0
      ? `${health.bindings.active > 0 ? `${t.connectedAccounts({ count: health.bindings.active })} · ` : ""}${t.degradedAccounts({ count: health.bindings.degraded })}`
      : health.bindings.active > 0
        ? t.connectedAccounts({ count: health.bindings.active })
        : health.bindings.pending > 0
          ? t.pendingAccounts({ count: health.bindings.pending })
          : t.noConnectedAccount;
  const discovery = `${t.discoveredFolders({ count: health.discovery.activeFolders })}${
    reviewCount > 0 ? ` · ${t.foldersNeedReview({ count: reviewCount })}` : ""
  }`;
  const synchronization =
    health.sync.runningRuns > 0
      ? t.synchronizationsRunning({ count: health.sync.runningRuns })
      : degradedFolders > 0
        ? `${t.degradedFolders({ count: degradedFolders })}${currentFolders > 0 ? ` · ${t.currentFolders({ count: currentFolders })}` : ""}`
        : rebuildingFolders > 0
          ? t.rebuildingFolders({ count: rebuildingFolders })
          : syncingFolders > 0
            ? t.synchronizingFolders({ count: syncingFolders })
            : currentFolders > 0
              ? t.currentFolders({ count: currentFolders })
              : pendingFolders > 0
                ? t.pendingFolders({ count: pendingFolders })
                : t.noSynchronizedFolders;
  const search = health.search.bm25Ready ? t.searchAdvanced : t.searchStandard;

  return { accounts, discovery, synchronization, search };
};

export const formatHealthEventAge = (input: string, base: Date = new Date(), locale = "en"): string => {
  const resolved = healthMessages.resolve([locale]);
  const elapsedMs = Math.max(0, base.getTime() - Date.parse(input));
  if (elapsedMs < 5_000) return resolved.t.justNow;

  const units = [
    [24 * 60 * 60 * 1_000, "day"],
    [60 * 60 * 1_000, "hour"],
    [60 * 1_000, "minute"],
    [1_000, "second"],
  ] as const;
  const [unitMs, unit] = units.find(([threshold]) => elapsedMs >= threshold) ?? units.at(-1)!;
  return new Intl.RelativeTimeFormat(resolved.locale, { numeric: "always" }).format(-Math.floor(elapsedMs / unitMs), unit);
};

export const mailboxOverviewSubtitle = (
  mailbox: Pick<Mailbox, "health" | "healthReason"> & { receivingAddress: string | null },
  locale = "en",
): string => {
  const address = mailbox.receivingAddress ?? healthMessages.resolve([locale]).t.noReceivingAddress;
  const health = mailboxHealthPresentation(mailbox, locale);
  return health ? `${address} · ${health.title}` : address;
};
