export const DATA_BLOCK_DEFAULT_REF = "ref";

export const buildDataBlockTemplate = (ref = DATA_BLOCK_DEFAULT_REF): string => `@${ref}
:::data
key: value
:::`;

export const dataBlockRefSelection = (insertStart: number, ref = DATA_BLOCK_DEFAULT_REF) => ({
  anchor: insertStart + 1,
  head: insertStart + 1 + ref.length,
});
