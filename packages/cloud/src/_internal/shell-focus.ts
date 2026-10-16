export const SHELL_FOCUS_COOKIE = "cloud_shell_focus";

export const readShellFocusCookie = (cookieHeader: string | null | undefined): boolean =>
  cookieHeader
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SHELL_FOCUS_COOKIE}=`))
    ?.slice(SHELL_FOCUS_COOKIE.length + 1) === "1";

export const shellFocusCookie = (hidden: boolean, secure: boolean): string =>
  `${SHELL_FOCUS_COOKIE}=${hidden ? "1" : ""}; Path=/; Max-Age=${hidden ? 31536000 : 0}; SameSite=Lax${secure ? "; Secure" : ""}`;
