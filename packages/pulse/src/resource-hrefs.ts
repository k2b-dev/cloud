export const pulseBaseHref = (baseId: string): string => `/app/pulse/${baseId}`;

export const pulseSourceHref = (baseId: string, sourceId: string): string =>
  `${pulseBaseHref(baseId)}/sources/${encodeURIComponent(sourceId)}`;
