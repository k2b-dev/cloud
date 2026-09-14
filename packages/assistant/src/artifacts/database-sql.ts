/** A deliberately small SELECT subset for untrusted Assistant scripts, not a SQL proxy. */
const forbidden = new Set(
  "insert update delete create alter drop replace attach detach pragma vacuum reindex analyze load_extension readfile writefile eval returning".split(
    " ",
  ),
);
const functions = new Set(
  "count sum avg min max total abs round coalesce nullif ifnull lower upper length substr substring trim ltrim rtrim date datetime time strftime julianday unixepoch json_extract json_type json_array_length cast".split(
    " ",
  ),
);
const syntaxBeforeParen = new Set(["in", "as", "over", "exists", "select", "from", "where", "and", "or", "not", "filter"]);
export function safeQuery(sql: string, parameterCount?: number) {
  const tokens: { word: string; quoted: boolean }[] = [];
  sql = sql.trim().replace(/;$/, "").trimEnd();
  let rest = sql;
  while (rest) {
    const match = /^(\s+|'(?:''|[^'])*'|"(?:""|[^"])*"|\[(?:[^\]])*\]|[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|[(),.?+*/%=<>!|-])/.exec(rest);
    if (!match) throw new Error("DB_SQL_UNSUPPORTED");
    const token = match[0];
    rest = rest.slice(token.length);
    if (/^\s/.test(token)) continue;
    if (token.startsWith("'")) {
      tokens.push({ word: "literal", quoted: true });
      continue;
    }
    const quoted = token.startsWith('"') || token.startsWith("[");
    const word = (quoted ? token.slice(1, -1) : token).toLowerCase();
    if (quoted && !/^[a-z][a-z0-9_]*$/.test(word)) throw new Error("DB_SQL_UNSUPPORTED");
    if (word.startsWith("pragma") || forbidden.has(word)) throw new Error("DB_SQL_UNSUPPORTED");
    tokens.push({ word, quoted });
  }
  if (tokens[0]?.word !== "select" || tokens[0]?.quoted) throw new Error("DB_SQL_UNSUPPORTED");
  for (let i = 0; i < tokens.length; i++) {
    const current = tokens[i]!,
      next = tokens[i + 1];
    if ((current.word === "-" && next?.word === "-") || (current.word === "/" && next?.word === "*")) throw new Error("DB_SQL_UNSUPPORTED");
    if (next?.word === "(" && /^[a-z]/.test(current.word) && !functions.has(current.word) && !syntaxBeforeParen.has(current.word))
      throw new Error("DB_SQL_UNSUPPORTED");
  }
  if (parameterCount !== undefined && tokens.filter(token => token.word === "?" && !token.quoted).length !== parameterCount) throw new Error("DB_SQL_PARAMS");
  return `SELECT * FROM (${sql}) LIMIT 1001`;
}
