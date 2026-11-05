import { i18n } from "@k2b/stdlib";
import { resolveCapabilityManifestPresentation } from "../../_internal/capabilities";
import { createCapabilityDeadline } from "../../_internal/capability-timeout";
import { getApp, getCapability } from "../../_internal/registry";
import { CloudResourceRefSchema } from "../../contracts/capabilities";
import type { PermissionLevel } from "../../contracts/shared";
import { resolveAppIdentityPresentation } from "../../shared/app-presentation";
import { REQUEST_IDLE_TIMEOUT_SECONDS } from "../request-timeout";

export const codeMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      accountName: ({ title }: { title: string }) => `Code of ${title}`,
      accountType: ({ type }: { type: string }) => `Code of a resource (${type})`,
      unknownType: "Code of a resource",
      unknownApp: "Code of an app",
      resourceAccount: ({ type }: { type: string }) => `Service account of a resource (${type})`,
      appAccount: "Service account of an app",
      unknownResourceAccount: "Service account of a resource",
      disabled: "disabled",
    },
    de: {
      accountName: ({ title }) => `Code von ${title}`,
      accountType: ({ type }) => `Code eines Objekts (${type})`,
      unknownType: "Code eines Objekts",
      unknownApp: "Code einer App",
      resourceAccount: ({ type }) => `Dienstkonto eines Objekts (${type})`,
      appAccount: "Dienstkonto einer App",
      unknownResourceAccount: "Dienstkonto eines Objekts",
      disabled: "deaktiviert",
    },
  },
});

/** The technical name remains the sole owner binding; these are never account binding columns. */
export const codeAccountOwner = (name: string) => {
  const match = /^code:([^:]+):(.+)$/.exec(name);
  if (!match) return null;
  const [, type = "", id = ""] = match;
  if (type === "app") return /^[a-z][a-z0-9-]*$/.test(id) ? { kind: "app" as const, appId: id } : null;
  const ref = CloudResourceRefSchema.safeParse({ type, id });
  return ref.success ? { kind: "resource" as const, ref: ref.data } : null;
};

export type CodeAccountDisplayContext = {
  /** The target service's checked effective permission. Manage presentation is derived automatically. */
  permission?: PermissionLevel;
  /** The target application checked Manage locally for this viewer and this exact rights list. Defaults to false. */
  canManageTarget?: boolean;
  cloudAdmin?: boolean;
  locale?: string;
};
export type CodeAccountPresentation = {
  displayName: string;
  serviceAccountDescription: string;
  serviceAccountHref?: string;
  serviceAccountHandle?: string;
};

// Leave half the ordinary request idle budget for grant reads and sending the response.
const displayCatalog = async (appId: string) => {
  const deadline = createCapabilityDeadline((REQUEST_IDLE_TIMEOUT_SECONDS * 1_000) / 2, new AbortController().signal);
  try {
    const app = await deadline.wait(() => getCapability(appId));
    const identity = app
      ? { name: app.appName, description: app.appDescription, presentation: app.appPresentation }
      : await deadline.wait(() => getApp(appId));
    return { app, identity, available: true };
  } catch {
    return { app: null, identity: null, available: false };
  } finally {
    deadline.clear();
  }
};

/** Registry metadata only: no owner reader, SQL, or app call. Reuse one presenter for an entire rights list. */
export const codeAccountPresenter = (context: CodeAccountDisplayContext = {}) => {
  const canManageTarget = context.permission !== undefined ? context.permission === "admin" : context.canManageTarget === true;
  const { t } = codeMessages.resolve(context.locale ? [context.locale] : []);
  const catalogs = new Map<string, ReturnType<typeof displayCatalog>>();
  return async (account: {
    name: string;
    title: string | null;
    handle?: string | null;
    status?: string;
  }): Promise<CodeAccountPresentation> => {
    const owner = codeAccountOwner(account.name);
    const appId = owner?.kind === "app" ? owner.appId : owner?.ref.type.split(".")[0];
    let catalog = appId ? catalogs.get(appId) : undefined;
    if (appId && !catalog) {
      catalog = displayCatalog(appId);
      catalogs.set(appId, catalog);
    }
    const resolved = await catalog;
    if (resolved?.available === false) {
      return {
        // The target already admitted this viewer; registry availability does not change that authority.
        displayName:
          canManageTarget && account.title ? t.accountName({ title: account.title }) : owner?.kind === "app" ? t.unknownApp : t.unknownType,
        serviceAccountDescription: [
          owner?.kind === "app" ? t.appAccount : t.unknownResourceAccount,
          account.status === "disabled" ? t.disabled : null,
        ]
          .filter(Boolean)
          .join(" · "),
        ...(canManageTarget && account.handle ? { serviceAccountHandle: account.handle } : {}),
      };
    }
    const app = resolved?.app;
    const manifest =
      app && context.locale ? resolveCapabilityManifestPresentation(app.manifest, app.presentation, context.locale) : app?.manifest;
    const localType = owner?.kind === "resource" ? owner.ref.type.slice((appId?.length ?? 0) + 1) : null;
    const ownerType = manifest?.types.find((type) => type.localId === localType);
    const type = ownerType?.title;
    // An app's name is visible in the installation anyway; it is shown in the viewer's language, never as stored. An
    // app without a capability catalog still has its registry entry; only an app that is gone keeps the stored name.
    const appIdentity = owner?.kind === "app" ? resolved?.identity : null;
    const appTitle = appIdentity ? resolveAppIdentityPresentation(appIdentity, context.locale ?? "en").name : null;
    const visibleTitle = owner?.kind === "app" ? (appTitle ?? account.title) : canManageTarget ? account.title : null;
    const page = localType ? manifest?.code?.pages?.[localType] : undefined;
    const href =
      owner?.kind === "app"
        ? context.cloudAdmin
          ? `/admin/code?sec=code&app=${encodeURIComponent(owner.appId)}`
          : undefined
        : owner?.kind === "resource" && canManageTarget && page
          ? page.replace("{id}", encodeURIComponent(owner.ref.id))
          : undefined;
    const displayName = visibleTitle
      ? t.accountName({ title: visibleTitle })
      : (ownerType?.codeAccount?.name ?? (type ? t.accountType({ type }) : t.unknownType));
    return {
      displayName,
      serviceAccountDescription: [
        owner?.kind === "app"
          ? t.appAccount
          : (ownerType?.codeAccount?.description ?? (type ? t.resourceAccount({ type }) : t.unknownResourceAccount)),
        account.status === "disabled" ? t.disabled : null,
      ]
        .filter(Boolean)
        .join(" · "),
      ...(href ? { serviceAccountHref: href } : {}),
      ...(canManageTarget && account.handle ? { serviceAccountHandle: account.handle } : {}),
    };
  };
};
