/** Warm action code after mounting; WebKit has no requestIdleCallback. */
export function panelIdle(work: () => void): () => void {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(work);
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(work, 200);
  return () => clearTimeout(id);
}
