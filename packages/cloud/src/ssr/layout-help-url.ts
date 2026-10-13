/** Build a canonical, reload-safe URL on an app-owned Help route. */
export const layoutHelpTopicHref = (pageBase: string, topicId: string | null) => {
  const base = pageBase.endsWith("/") ? pageBase.slice(0, -1) : pageBase;
  return topicId ? `${base}/${encodeURIComponent(topicId)}` : base;
};

/** The app named by Core's exact full-page Help route. */
export const helpPageAppId = (pathname: string): string | null => {
  const match = /^\/help\/apps\/([^/]+)(?:\/[^/]+)?\/?$/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
};

type HelpLinkTarget = { kind: "section"; hash: string } | { kind: "topic"; topicId: string | null; hash: string };

/** Same-app Help links that the reader can open in place. */
export const helpLinkTarget = (href: string, current: string, help: { appId?: string; pageBase?: string }): HelpLinkTarget | null => {
  try {
    if (href.startsWith("#")) {
      const hash = decodeURIComponent(href.slice(1));
      return hash ? { kind: "section", hash } : null;
    }
    const source = new URL(current);
    const target = new URL(href, source);
    if (target.origin !== source.origin || target.search) return null;
    const bases = [help.pageBase?.replace(/\/$/, ""), help.appId ? `/help/apps/${encodeURIComponent(help.appId)}` : undefined];
    const hash = decodeURIComponent(target.hash.slice(1));
    for (const base of bases) {
      if (!base) continue;
      const path = target.pathname.replace(/\/$/, "");
      if (path === base) return { kind: "topic", topicId: null, hash };
      if (!path.startsWith(`${base}/`)) continue;
      const segment = path.slice(base.length + 1);
      if (segment && !segment.includes("/")) return { kind: "topic", topicId: decodeURIComponent(segment), hash };
    }
    return null;
  } catch {
    return null;
  }
};
