/**
 * Reads a JSON `{ message }` payload from a non-OK fetch response, falling
 * back to a caller-supplied default. Shared across the grids islands so we
 * don't copy this 6-line block into every mutation.
 */
export const errorMessage = async (res: Pick<Response, "json">, fallback: string): Promise<string> => {
  try {
    const data: unknown = await res.json();
    if (data && typeof data === "object") {
      const message = Object.getOwnPropertyDescriptor(data, "message")?.value;
      if (typeof message === "string" && message.length > 0) return message;
    }
  } catch {}
  return fallback;
};
