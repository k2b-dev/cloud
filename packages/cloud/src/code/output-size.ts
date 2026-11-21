// This contract also loads in minimal script VMs without Web Encoding globals.
// Count the JSON wire representation in UTF-8; iteration keeps surrogate pairs together.
export const codeOutputJsonBytes = (value: unknown) => {
  let size = 0;
  for (const character of JSON.stringify(value) ?? "") {
    const code = character.charCodeAt(0);
    size += character.length === 2 ? 4 : code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
  }
  return size;
};
