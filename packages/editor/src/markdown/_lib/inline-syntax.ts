// Text syntax shared by editor decorations and the server preview.
export const TAG_REGEX = /(^|\s)#([a-zA-Z][\w-]*(?:\/[\w-]+)*)/g;
export const MARK_REGEX = /==(?!=)([^\s=][^=]*?[^\s=]|[^\s=])==(?!=)/g;
export const SUB_REGEX = /(?<!~)~(?!~)([^~\s]+)~(?!~)/g;
export const SUP_REGEX = /\^([^\^\s]+)\^/g;

// CodeMirror highlightSpecialChars defaults (tabs keep their native tab-size).
export const SPECIAL_CHAR_REGEX =
  /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u00ad\u061c\u200b\u200e\u200f\u2028\u2029\u202d\u202e\u2066\u2067\u2069\ufeff\ufff9-\ufffc]/gu;
