import type { AppsFormat } from "./format";
import { type AppHint, HINT_PRESENTATION, type HintTarget } from "./model";
import type { AppsPageMessages } from "./page-messages";
import type { AppPageData } from "./view-data";

// How a hint reads: one line for the list, and for the app's page its cause in words with exactly one way out.

/** The one-line version of a hint, for the list. */
export function hintShort(t: AppsPageMessages, f: AppsFormat, hint: AppHint): string {
  switch (hint.kind) {
    case "startRejected":
      return t.hintStartRejectedShort({ reason: hint.reason });
    case "notRunning":
      return t.hintNotRunningShort({ since: hint.since ? f.moment(hint.since) : t.unknown });
    case "providerOnly":
      return t.hintProviderOnlyShort({ provider: hint.provider, date: hint.lastSeenAt ? f.date(hint.lastSeenAt) : t.unknown });
    case "neverStarted":
      return hint.hasKey ? t.hintNeverStartedShort : t.hintNoKeyShort;
    case "keyRevoked":
      return t.hintKeyRevokedShort;
    case "errorRate":
      return t.hintErrorRateShort({ rate: f.percent(hint.rate) });
    case "failedDeliveries":
      return t.hintFailedDeliveriesShort({ count: hint.count });
    case "routeMissing":
      return t.hintRouteMissingShort({ prefix: hint.prefix });
    case "accessUnmanaged":
      return t.hintAccessUnmanagedShort;
    case "envStart":
      return t.hintEnvStartShort;
    case "rotation":
      return t.hintRotationShort;
    case "runtime":
      return t.hintRuntimeShort({ message: hint.message });
  }
}

export const noteTone = (hint: AppHint): "neutral" | "warning" | "danger" =>
  hint.kind === "runtime" && hint.severity === "error" ? "danger" : HINT_PRESENTATION[hint.kind].tone;

/** The words of one hint on the app's page and its one way out; `create` opens the keys view with "Create key". */
export type HintWords = {
  lead: string;
  text: string;
  action: string;
  create?: boolean;
  primary?: boolean;
  docs?: string | null;
  docsLabel?: string;
  target: HintTarget;
};

export function hintWords(t: AppsPageMessages, f: AppsFormat, app: AppPageData, hint: AppHint): HintWords {
  const entry = app.entry;
  const failedEvent = () =>
    app.details?.hears.find((hearing) => hearing.failedDeliveries.length > 0)?.title ??
    app.details?.hears.find((hearing) => hearing.counts.failed > 0)?.eventType ??
    null;
  /** `create` opens the keys column with the create dialog; `primary` marks the one filled action of the page. */
  const text = (): {
    lead: string;
    text: string;
    action: string;
    create?: boolean;
    primary?: boolean;
    docs?: string | null;
    docsLabel?: string;
  } => {
    switch (hint.kind) {
      case "startRejected": {
        // The refusal stays until the next successful start, so its cause may be gone in Core by now. The way out
        // follows what still blocks a start: background access, then a key Core would accept.
        const off = entry.keys.accountStatus === "disabled";
        const keyReady =
          app.startKeyReady ??
          (hint.reason === "disabled" ? entry.keys.active > 0 : entry.keys.active > (hint.reason === "connections_not_permitted" ? 1 : 0));
        const next = off ? "reenable" : keyReady ? "restart" : "newKey";
        const lead = t.hintStartRejectedLead({ name: entry.name, live: entry.live });
        const text = `${t.hintStartRejectedText({ reason: hint.reason, when: f.relative(hint.at), off })} ${t.hintStartRejectedNext({ next })}`;
        const docs = { docs: app.docs.recover, docsLabel: t.docsWhatNow };
        if (next === "reenable") return { lead, text, action: t.actReenable, primary: true };
        if (next === "restart") return { lead, text, action: t.actKeysShow, ...docs };
        return { lead, text, action: t.actNewKey, create: true, primary: true, ...docs };
      }
      case "notRunning": {
        const since = hint.since ? f.moment(hint.since) : t.unknown;
        return { lead: t.hintNotRunningLead({ since }), text: t.hintNotRunningText({ name: entry.name }), action: t.actErrors };
      }
      case "providerOnly": {
        const date = hint.lastSeenAt ? f.date(hint.lastSeenAt) : t.unknown;
        return {
          lead: t.hintProviderOnlyLead({ provider: hint.provider }),
          text: t.hintProviderOnlyText({ provider: hint.provider, id: entry.id, date }),
          action: t.remove,
        };
      }
      case "neverStarted":
        return { lead: t.hintNeverStartedLead, text: t.hintNeverStartedText, action: hint.hasKey ? t.actKeysShow : t.actKeys };
      case "keyRevoked":
        return {
          lead: t.hintKeyRevokedLead,
          text: t.hintKeyRevokedText({ name: app.revokedKeyName ?? "" }),
          action: t.actNewKey,
          create: true,
          primary: true,
          docs: app.docs.recover,
          docsLabel: t.docsWhatNow,
        };
      case "envStart":
        return {
          lead: t.hintEnvStartLead,
          text: hint.hasKey ? t.hintEnvStartKeyText({ name: entry.name }) : t.hintEnvStartText({ name: entry.name }),
          action: hint.hasKey ? t.actKeysShow : t.actKeys,
          create: !hint.hasKey,
          docs: app.docs.migrate,
          docsLabel: t.docsMigration,
        };
      case "rotation":
        return { lead: t.hintRotationShort, text: "", action: t.actKeysShow };
      case "errorRate":
        return { lead: t.hintErrorRateLead({ rate: f.percent(hint.rate) }), text: t.hintErrorRateText, action: t.actErrors };
      case "failedDeliveries":
        return {
          lead: t.hintFailedDeliveriesLead({ count: hint.count }),
          text: t.hintFailedDeliveriesText({ name: entry.name, event: failedEvent() }),
          action: t.actEvents,
        };
      case "routeMissing":
        return {
          lead: t.hintRouteMissingLead({ prefix: hint.prefix }),
          text: t.hintRouteMissingText({ name: entry.name, owner: hint.owner }),
          action: t.actRoutes,
        };
      case "accessUnmanaged":
        return { lead: t.hintAccessUnmanagedLead, text: t.hintAccessUnmanagedText, action: t.actAccess };
      case "runtime":
        return { lead: hint.message, text: "", action: t.actRuntime };
    }
  };
  return { ...text(), target: HINT_PRESENTATION[hint.kind].target };
}
