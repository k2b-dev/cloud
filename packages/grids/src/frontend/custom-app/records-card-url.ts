export const customAppCardFileUrl = (recordsEndpoint: string, contentToken: string): string => {
  const url = new URL(recordsEndpoint, "https://custom-app.invalid");
  url.pathname = url.pathname.replace(/\/records$/, `/files/${encodeURIComponent(contentToken)}`);
  url.searchParams.delete("_search");
  url.searchParams.delete("_cursor");
  return `${url.pathname}${url.search}`;
};
