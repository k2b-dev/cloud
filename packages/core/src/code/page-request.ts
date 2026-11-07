import type { CodePageTree } from "@k2b/cloud/code";

/** Delivers the events a page follows. Calls `onEvent` for each matching event its viewer may see. */
export type CodePageEventSource = {
  subscribe: (types: readonly string[], onEvent: () => void) => () => void;
};

export type CodePageAnswer =
  /** Hosting checked the tree; `url` is set when a redirect led to another page. */
  | { kind: "tree"; tree: CodePageTree; csrf: string; url: string | null }
  /** The Code answered with data rather than a page. */
  | { kind: "done" }
  /** A redirect led to something other than a page; the browser opens it. */
  | { kind: "navigate"; url: string }
  | { kind: "failed"; code: string | undefined };

/**
 * Loads a page tree for the island, or posts a form to the Code. Only hosting marks a checked tree with the
 * `X-Code-Page` response header, which Code responses cannot set, so Code JSON never renders as a page.
 * Never retries: a POST that lost its answer must not run twice.
 */
export async function requestCodePage(url: string, body?: URLSearchParams): Promise<CodePageAnswer> {
  // A POST whose answer is lost may have run: the page says so instead of claiming it did not.
  const lost: CodePageAnswer = { kind: "failed", code: body ? "code_answer_lost" : undefined };
  let response: Response;
  try {
    response = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: body ? { "X-Code-Page": "tree", "Content-Type": "application/x-www-form-urlencoded" } : { "X-Code-Page": "tree" },
      body,
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    return lost;
  }
  if (response.ok && response.headers.get("X-Code-Page") === "tree") {
    try {
      const page: { tree: CodePageTree; csrf: string } = await response.json();
      return { kind: "tree", tree: page.tree, csrf: page.csrf, url: response.redirected ? response.url : null };
    } catch {
      return lost;
    }
  }
  if (response.ok) return response.redirected ? { kind: "navigate", url: response.url } : { kind: "done" };
  const failure: unknown = await response.json().catch(() => null);
  const code = failure && typeof failure === "object" && "code" in failure && typeof failure.code === "string" ? failure.code : undefined;
  return { kind: "failed", code };
}

/** Form fields as hosting reads them: text values only, in document order, including the CSRF field. */
export function codePageFormBody(form: HTMLFormElement): URLSearchParams {
  const body = new URLSearchParams();
  for (const [name, value] of new FormData(form)) if (typeof value === "string") body.append(name, value);
  return body;
}
