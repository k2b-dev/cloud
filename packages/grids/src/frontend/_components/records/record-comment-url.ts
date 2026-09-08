export const recordCommentUrl = (endpoint: string, commentId: string): string => {
  const url = new URL(endpoint, "https://grids.invalid");
  url.pathname = `${url.pathname}/${encodeURIComponent(commentId)}`;
  return `${url.pathname}${url.search}`;
};

export const recordCommentsCursorUrl = (endpoint: string, cursor: string, parameter: "cursor" | "_cursor"): string => {
  const url = new URL(endpoint, "https://grids.invalid");
  url.searchParams.set(parameter, cursor);
  return `${url.pathname}${url.search}`;
};
