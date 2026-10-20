import { PANEL_CONTEXT_PARAM, type PanelPageContext, parsePanelContextParam } from "../contracts/panel-context";

/** Untrusted URL input: a selector only. Read through your server using the session's actor/accessSubject. */
export function readPanelContext(c: { req: { raw: { url: string } } }): PanelPageContext | null {
  try {
    return parsePanelContextParam(new URL(c.req.raw.url).searchParams.get(PANEL_CONTEXT_PARAM));
  } catch {
    return null;
  }
}
