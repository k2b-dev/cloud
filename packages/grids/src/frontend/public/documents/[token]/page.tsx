import { type AuthContext, getDateConfig, getLocale } from "@k2b/cloud/server";
import { MinimalLayout } from "@k2b/cloud/ssr";
import { ssr } from "../../../../config";
import { gridsService } from "../../../../service";
import { resolveGridsMessages } from "../../../messages";
import { PublicDocumentShare } from "./PublicDocumentShare";

export default ssr<AuthContext>(async (c) => {
  const token = c.req.param("token") ?? "";
  const locale = getLocale(c);
  const { t } = resolveGridsMessages(locale);
  const resolved = await gridsService.document.resolveDocumentLinkDownload(token);
  if (!resolved.ok) {
    c.status(404);
    c.get("page").title = t.linkUnavailable;
    return () => (
      <MinimalLayout c={c} ui="v2">
        <PublicDocumentShare />
      </MinimalLayout>
    );
  }

  const dateConfig = await getDateConfig(c);
  const expiresAt = resolved.data.link.expiresAt;
  const expiresAtLabel = new Intl.DateTimeFormat(dateConfig.locale, {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: dateConfig.timeZone,
  }).format(new Date(expiresAt));

  c.get("page").title = resolved.data.document.filename;
  c.get("page").description = t.sharedDocumentDescription;

  return () => (
    <MinimalLayout c={c} ui="v2">
      <PublicDocumentShare
        filename={resolved.data.document.filename}
        mimeType={resolved.data.document.artifacts.find((artifact) => artifact.key === resolved.data.document.primaryArtifactKey)?.mimeType}
        expiresAt={expiresAt}
        expiresAtLabel={expiresAtLabel}
        downloadHref={`/share/grids/documents/${encodeURIComponent(token)}/download`}
      />
    </MinimalLayout>
  );
});
