// The @k2b/ui Plex preset, imported as text (`with { type: "text" }`). The
// importing module references this file, so npm consumers that type-check
// Cloud's sources get the declaration without adding it to their tsconfig.
declare module "@k2b/ui/fonts/plex.css" {
  const content: string;
  export default content;
}
