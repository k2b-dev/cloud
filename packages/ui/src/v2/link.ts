import { Link } from "@k2b/ssr/nav";

/**
 * The element of something pressable (internal): a link renders `@k2b/ssr/nav`'s `Link`, so `onNavigate` follows its
 * one contract (plain same-origin clicks only, a pending page swap cancelled, history through the event); anything
 * else renders the given element.
 */
export const linkOr = <const T extends "a" | "button" | "span">(href: string | undefined, otherwise: T): typeof Link | T =>
  href !== undefined ? Link : otherwise;
