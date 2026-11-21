import { i18n } from "@k2b/stdlib";
import { AppWorkspace, useLocale } from "@k2b/ui";

// Owner apps render this navigation on their first load; keep the Code page's full catalog out of that bundle.
const codeNavMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: { navAttention: "Code needs attention" },
    de: { navAttention: "Code braucht Aufmerksamkeit" },
  },
});

/** The phrase screen readers hear for the owner's "Code" entry when its Code needs someone. */
export const codeNavAttentionLabel = (locale: string): string => codeNavMessages.resolve([locale]).t.navAttention;

/**
 * The status of an owner's "Code" navigation entry: a warning dot when the Code needs attention, never a number.
 * Any owner app puts it in the entry's `meta`, with the answer from `loadCodeAttention` or the Code page.
 */
export function CodeNavStatus(props: { attention: boolean }) {
  const locale = useLocale();
  return <AppWorkspace.SidebarItemStatus attention={props.attention ? codeNavAttentionLabel(locale()) : undefined} />;
}

export default CodeNavStatus;
