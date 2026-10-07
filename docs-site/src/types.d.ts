declare module "*.md" {
  const content: string;
  export default content;
}

/** Imported as text for the base stylesheet demo. */
declare module "@k2b/ui/base.css" {
  const content: string;
  export default content;
}
