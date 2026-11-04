import { i18n } from "@k2b/stdlib";
import { resolveCapabilityManifestPresentation } from "../../_internal/capabilities";
import { getCapability } from "../../_internal/registry";
import { CloudResourceRefSchema } from "../../contracts/capabilities";

export const codeMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      accountName: ({ title }: { title: string }) => `Code of ${title}`,
      accountType: ({ type }: { type: string }) => `Code of a resource (${type})`,
      unknownType: "Code of a resource",
      resourceAccount: ({ type }: { type: string }) => `Service account of a resource (${type})`,
      appAccount: "Service account of an app",
      unknownResourceAccount: "Service account of a resource",
      disabled: "disabled",
    },
    de: {
      accountName: ({ title }) => `Code von ${title}`,
      accountType: ({ type }) => `Code eines Objekts (${type})`,
      unknownType: "Code eines Objekts",
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
  /** The target application checked Manage locally for this viewer and this exact rights list. Defaults to false. */
  canManageTarget?: boolean;
  cloudAdmin?: boolean;
  locale?: string;
};
export type CodeAccountPresentation = { displayName: string; serviceAccountDescription: string; serviceAccountHref?: string };

/** Registry metadata only: no owner reader, SQL, or app call. Reuse one presenter for an entire rights list. */
export const codeAccountPresenter = (context: CodeAccountDisplayContext = {}) => {
  const { t } = codeMessages.resolve(context.locale ? [context.locale] : []);
  const catalogs = new Map<string, ReturnType<typeof getCapability>>();
  return async (account: { name: string; title: string | null; status?: string }): Promise<CodeAccountPresentation> => {
    const owner = codeAccountOwner(account.name);
    const appId = owner?.kind === "app" ? owner.appId : owner?.ref.type.split(".")[0];
    let catalog = appId ? catalogs.get(appId) : undefined;
    if (appId && !catalog) {
      catalog = getCapability(appId).catch(() => null);
      catalogs.set(appId, catalog);
    }
    const app = await catalog;
    const manifest =
      app && context.locale ? resolveCapabilityManifestPresentation(app.manifest, app.presentation, context.locale) : app?.manifest;
    const localType = owner?.kind === "resource" ? owner.ref.type.slice((appId?.length ?? 0) + 1) : null;
    const ownerType = manifest?.types.find((type) => type.localId === localType);
    const type = ownerType?.title;
    const visibleTitle = owner?.kind === "app" ? (account.title ?? app?.appName) : context.canManageTarget ? account.title : null;
    const page = localType ? manifest?.code?.pages?.[localType] : undefined;
    const href =
      owner?.kind === "app"
        ? context.cloudAdmin
          ? "/admin/code"
          : undefined
        : owner?.kind === "resource" && context.canManageTarget && page
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
    };
  };
};
