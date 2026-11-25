/**
 * k2b-ui gap: the v2 `Input` takes no `autocomplete`. Sign-in and password fields need it so password managers and
 * one-time codes fill the right field; until the primitive has it, its `ref` sets the attribute when the island
 * comes alive (the server's markup is without it).
 */
export const autocomplete = (value: string) => (element: HTMLInputElement | HTMLTextAreaElement) => {
  element.setAttribute("autocomplete", value);
};
