import type { PulseDashboardCondition, PulseDashboardControl, PulseDashboardRow } from "../contracts";
import type {
  ControlOptionState,
  DashboardContainerBody,
  DashboardDslBlock,
  DashboardDslCard,
  DashboardDslControl,
  DashboardDslDocument,
  DashboardDslMap,
  DashboardDslMarkdown,
  DashboardDslRow,
  DashboardDslSection,
  DashboardDslVisual,
  MapBlockState,
  MarkdownBlockState,
  Position,
  Result,
  VisualBlockState,
} from "./ast";
import { CONDITION_LEVELS, CONDITION_OPERATORS, CONTROL_KINDS, MAP_FIELD_ROLES, MAP_SIZE_MODES, VISUALS } from "./constants";

const visualFromKeyword = (keyword: string): DashboardDslVisual["visual"] => {
  return keyword as DashboardDslVisual["visual"];
};

const variableFromLabel = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40) || "value";

class Parser {
  private diagnostics: Result<never>["diagnostics"] = [];
  private position: Position = { index: 0, line: 1, column: 1 };

  constructor(private readonly input: string) {}

  parse(): Result<DashboardDslDocument> {
    this.skipWhitespace();
    const start = this.position;
    const keyword = this.readIdentifier();
    if (keyword !== "dashboard") {
      this.error(start, 'Dashboard DSL must start with dashboard "Name" { ... }');
      return { ok: false, diagnostics: this.diagnostics };
    }
    const title = this.readString();
    if (title === null) this.error(this.position, "Dashboard title must be a quoted string");
    if (!this.readOpenBrace()) this.error(this.position, 'Expected "{" after dashboard title');
    const body = this.readContainerBody(["description", "controls", "section", "card", "markdown", "map", "row", ...VISUALS]);
    const document: DashboardDslDocument = {
      kind: "dashboard",
      title: title ?? "Dashboard",
      description: body.description,
      controls: body.controls,
      blocks: body.blocks,
    };
    this.skipWhitespace();
    if (!this.isEnd()) this.error(this.position, `Unexpected trailing content "${this.peek()}"`);
    return this.diagnostics.length ? { ok: false, diagnostics: this.diagnostics } : { ok: true, data: document, diagnostics: [] };
  }

  private readContainerBody(allowed: Iterable<string>): DashboardContainerBody {
    const allowedSet = new Set(allowed);
    const body: DashboardContainerBody = { description: null, controls: [], blocks: [] };
    while (!this.isEnd()) {
      if (this.readContainerStatement(allowedSet, body) === "closed") return body;
    }
    this.error(this.position, 'Missing closing "}"');
    return body;
  }

  private readContainerStatement(allowedSet: Set<string>, body: DashboardContainerBody): "continue" | "closed" {
    this.skipWhitespace();
    if (this.peek() === "}") {
      this.advance();
      return "closed";
    }
    const statementStart = this.position;
    const keyword = this.readIdentifier();
    if (!keyword) {
      this.error(this.position, `Unexpected token "${this.peek() || "end of input"}"`);
      this.recoverToNextStatement();
      return "continue";
    }
    if (!allowedSet.has(keyword)) {
      this.error(statementStart, `Unsupported dashboard statement "${keyword}"`);
      this.recoverToNextStatement();
      return "continue";
    }
    this.applyContainerStatement(keyword, statementStart, body);
    return "continue";
  }

  private applyContainerStatement(keyword: string, statementStart: Position, body: DashboardContainerBody) {
    if (keyword === "description") {
      const value = this.readString();
      if (value === null) this.error(this.position, "Description must be a quoted string");
      else body.description = value;
      return;
    }
    if (keyword === "controls") {
      body.controls.push(...this.readControls(statementStart));
      return;
    }
    const block = this.readContainerBlock(keyword, statementStart);
    if (block) body.blocks.push(block);
  }

  private readContainerBlock(keyword: string, statementStart: Position): DashboardDslBlock | null {
    if (keyword === "section") return this.readSection(statementStart);
    if (keyword === "card") return this.readCard(statementStart);
    if (keyword === "row") return this.readRow(statementStart);
    if (keyword === "markdown") return this.readMarkdown(statementStart);
    if (keyword === "map") return this.readMap(statementStart);
    if (VISUALS.has(keyword)) return this.readVisual(keyword, statementStart);
    this.error(statementStart, `Unsupported dashboard statement "${keyword}"`);
    return null;
  }

  private readControls(start: Position): DashboardDslControl[] {
    if (!this.readOpenBrace()) {
      this.error(start, 'Expected "{" after controls');
      return [];
    }
    const controls: DashboardDslControl[] = [];
    while (!this.isEnd()) {
      this.skipWhitespace();
      if (this.peek() === "}") {
        this.advance();
        break;
      }
      const controlStart = this.position;
      const keyword = this.readIdentifier();
      if (!CONTROL_KINDS.has(keyword)) {
        this.error(controlStart, `Unsupported control "${keyword || this.peek()}"`);
        this.recoverToNextStatement();
        continue;
      }
      const label = this.readString();
      if (label === null) {
        this.error(controlStart, "Control label must be a quoted string");
        this.recoverToNextStatement();
        continue;
      }
      controls.push(this.readControlOptions(keyword as PulseDashboardControl["kind"], label));
    }
    return controls;
  }

  private readControlOptions(kind: PulseDashboardControl["kind"], label: string): DashboardDslControl {
    const options = this.readControlOptionState(variableFromLabel(label));
    const defaultValue = options.defaultValue || options.options[0] || (kind === "range" ? "24h" : "");
    return { kind, label, ...options, defaultValue };
  }

  private readControlOptionState(variable: string): ControlOptionState {
    const state: ControlOptionState = { variable, defaultValue: "", options: [], resourceType: null };
    while (this.hasInlineStatementContent()) {
      const optionStart = this.position;
      const keyword = this.readIdentifier();
      if (this.applyControlOption(keyword, state)) continue;
      this.error(optionStart, `Unsupported control option "${keyword || this.peek()}"`);
      this.recoverToNextStatement();
      break;
    }
    return state;
  }

  private applyControlOption(keyword: string, state: ControlOptionState): boolean {
    if (keyword === "variable") {
      state.variable = this.readBareOrString() ?? state.variable;
      return true;
    }
    if (keyword === "default") {
      state.defaultValue = this.readBareOrString() ?? state.defaultValue;
      return true;
    }
    if (keyword === "type") {
      state.resourceType = this.readBareOrString() ?? state.resourceType;
      return true;
    }
    if (keyword === "options") {
      this.readControlOptionList(state.options);
      return true;
    }
    return false;
  }

  private readControlOptionList(options: string[]) {
    while (this.hasInlineStatementContent()) {
      if (this.peek() === ",") {
        this.advance();
        continue;
      }
      const value = this.readBareOrString();
      if (!value) break;
      options.push(value);
    }
  }

  private hasInlineStatementContent(): boolean {
    this.skipInlineWhitespace();
    const next = this.peek();
    return next !== "" && next !== "\n" && next !== "\r" && next !== "}";
  }

  private readSection(start: Position): DashboardDslSection | null {
    const title = this.readString();
    if (title === null) {
      this.error(start, "Section title must be a quoted string");
      return null;
    }
    if (!this.readOpenBrace()) {
      this.error(this.position, 'Expected "{" after section title');
      return null;
    }
    const body = this.readContainerBody(["description", "section", "card", "markdown", "map", "row", ...VISUALS]);
    if (body.blocks.length === 0) this.error(start, `Section "${title}" must contain at least one section or widget`);
    return { kind: "section", title, description: body.description, blocks: body.blocks };
  }

  private readCard(start: Position): DashboardDslCard | null {
    const title = this.readString();
    if (title === null) {
      this.error(start, "Card title must be a quoted string");
      return null;
    }
    const span = this.readOptionalSpan();
    if (!this.readOpenBrace()) {
      this.error(this.position, 'Expected "{" after card title');
      return null;
    }
    const body = this.readContainerBody(["description", "markdown", "map", "row", ...VISUALS]);
    if (body.blocks.length === 0) this.error(start, `Card "${title}" must contain at least one widget`);
    return { kind: "card", title, description: body.description, span, blocks: body.blocks };
  }

  private readRow(start: Position): DashboardDslRow | null {
    const height = this.readOptionalHeight();
    if (!this.readOpenBrace()) {
      this.error(start, 'Expected "{" after row');
      return null;
    }
    const body = this.readContainerBody(["card", "markdown", "map", ...VISUALS]);
    if (body.blocks.length === 0) this.error(start, "Row must contain at least one widget");
    return { kind: "row", height, blocks: body.blocks };
  }

  private readMarkdown(start: Position): DashboardDslMarkdown | null {
    const title = this.tryReadString();
    const span = this.readOptionalSpan();
    if (!this.readOpenBrace()) {
      this.error(start, 'Expected "{" after markdown');
      return null;
    }
    const state = this.readMarkdownBody();
    if (state.content === null) this.error(start, "Markdown block must contain a triple-quoted string");
    return state.content === null
      ? null
      : { kind: "markdown", title, description: state.description, markdown: state.content.trim(), span };
  }

  private readVisual(keyword: string, start: Position): DashboardDslVisual | null {
    const title = this.readString();
    if (title === null) {
      this.error(start, "Widget title must be a quoted string");
      return null;
    }
    const span = this.readOptionalSpan();
    if (!this.readOpenBrace()) {
      this.error(this.position, 'Expected "{" after widget title');
      return null;
    }
    const state: VisualBlockState = {
      description: null,
      query: null,
      queryPosition: null,
      visual: visualFromKeyword(keyword),
      conditions: [],
    };
    this.readVisualBody(state);
    if (!state.query) this.error(start, `Widget "${title}" must contain a query statement`);
    return {
      kind: "visual",
      title,
      visual: state.visual,
      description: state.description,
      query: state.query,
      queryPosition: state.queryPosition,
      span,
      conditions: state.conditions,
    };
  }

  private readMap(start: Position): DashboardDslMap | null {
    const title = this.readString();
    if (title === null) {
      this.error(start, "Map title must be a quoted string");
      return null;
    }
    const span = this.readOptionalSpan();
    if (!this.readOpenBrace()) {
      this.error(this.position, 'Expected "{" after map title');
      return null;
    }
    const state: MapBlockState = {
      description: null,
      query: null,
      queryPosition: null,
      latitude: null,
      longitude: null,
      label: null,
      series: null,
      size: "count",
    };
    while (!this.isEnd()) {
      this.skipWhitespace();
      if (this.peek() === "}") {
        this.advance();
        break;
      }
      const statementStart = this.position;
      const statement = this.readIdentifier();
      if (statement === "description") this.readVisualDescription(state);
      else if (statement === "query") {
        state.queryPosition = statementStart;
        state.query = this.readLine().trim();
      } else if (statement === "latitude" || statement === "longitude" || statement === "label" || statement === "series") {
        this.readMapField(statement, statementStart, state);
      } else if (statement === "size") {
        const size = this.readIdentifier();
        if (!MAP_SIZE_MODES.has(size)) this.error(statementStart, 'Map size must be "count" or "sum"');
        else state.size = size as MapBlockState["size"];
      } else {
        this.error(statementStart, `Unsupported map statement "${statement || this.peek()}"`);
        this.recoverToNextStatement();
      }
    }
    if (!state.query) this.error(start, `Map "${title}" must contain a query statement`);
    if (!state.latitude) this.error(start, `Map "${title}" must contain a latitude selector`);
    if (!state.longitude) this.error(start, `Map "${title}" must contain a longitude selector`);
    return { kind: "map", title, span, ...state };
  }

  private readMapField(field: "latitude" | "longitude" | "label" | "series", start: Position, state: MapBlockState) {
    if (state[field]) {
      this.error(start, `Map ${field} selector can only be declared once`);
      this.recoverToNextStatement();
      return;
    }
    const role = this.readIdentifier();
    const path = this.readBareOrString();
    if (!MAP_FIELD_ROLES.has(role)) {
      this.error(start, `Map ${field} selector must use dimension or attribute`);
      return;
    }
    if (!path) {
      this.error(start, `Map ${field} selector path is missing`);
      return;
    }
    state[field] = { role: role as "dimension" | "attribute", path };
  }

  private readMarkdownBody(): MarkdownBlockState {
    const state: MarkdownBlockState = { description: null, content: null };
    while (!this.isEnd()) {
      if (this.readMarkdownStatement(state) === "closed") break;
    }
    return state;
  }

  private readMarkdownStatement(state: MarkdownBlockState): "continue" | "closed" {
    this.skipWhitespace();
    if (this.peek() === "}") {
      this.advance();
      return "closed";
    }
    if (this.startsWith('"""')) {
      state.content = this.readTripleString();
      return "continue";
    }
    const statementStart = this.position;
    const keyword = this.readIdentifier();
    if (keyword === "description") {
      const value = this.readString();
      if (value === null) this.error(this.position, "Description must be a quoted string");
      else state.description = value;
      return "continue";
    }
    this.error(statementStart, `Unsupported markdown statement "${keyword || this.peek()}"`);
    this.recoverToNextStatement();
    return "continue";
  }

  private readVisualBody(state: VisualBlockState) {
    while (!this.isEnd()) {
      if (this.readVisualStatement(state) === "closed") break;
    }
  }

  private readVisualStatement(state: VisualBlockState): "continue" | "closed" {
    this.skipWhitespace();
    if (this.peek() === "}") {
      this.advance();
      return "closed";
    }
    const statementStart = this.position;
    const statement = this.readIdentifier();
    if (statement === "description") this.readVisualDescription(state);
    else if (statement === "visual") this.readVisualOverride(statementStart, state);
    else if (statement === "query") this.readVisualQuery(statementStart, state);
    else if (CONDITION_LEVELS.has(statement))
      this.readVisualCondition(statement as PulseDashboardCondition["level"], statementStart, state);
    else {
      this.error(statementStart, `Unsupported widget statement "${statement || this.peek()}"`);
      this.recoverToNextStatement();
    }
    return "continue";
  }

  private readVisualDescription(state: Pick<VisualBlockState, "description">) {
    const value = this.readString();
    if (value === null) this.error(this.position, "Description must be a quoted string");
    else state.description = value;
  }

  private readVisualOverride(statementStart: Position, state: VisualBlockState) {
    const value = this.readIdentifier();
    if (!value || !VISUALS.has(value))
      this.error(statementStart, "Visual must be one of line, bar, stat, gauge, barGauge, histogram, heatmap, or table");
    else state.visual = visualFromKeyword(value);
  }

  private readVisualQuery(statementStart: Position, state: VisualBlockState) {
    state.queryPosition = statementStart;
    state.query = this.readLine().trim();
  }

  private readVisualCondition(level: PulseDashboardCondition["level"], statementStart: Position, state: VisualBlockState) {
    const condition = this.readCondition(level, statementStart);
    if (condition) state.conditions.push(condition);
  }

  private readCondition(level: PulseDashboardCondition["level"], start: Position): PulseDashboardCondition | null {
    const when = this.readIdentifier();
    if (when !== "when") {
      this.error(start, `${level} condition must use "when"`);
      this.recoverToNextStatement();
      return null;
    }
    const subject = this.readIdentifier();
    if (subject !== "value") {
      this.error(start, `${level} condition currently supports only "value"`);
      this.recoverToNextStatement();
      return null;
    }
    this.skipInlineWhitespace();
    const operator = this.readOperator();
    if (!CONDITION_OPERATORS.has(operator)) {
      this.error(start, `Unsupported condition operator "${operator}"`);
      this.recoverToNextStatement();
      return null;
    }
    const rawValue = this.readBareOrString();
    if (!rawValue) {
      this.error(start, "Condition value is missing");
      this.recoverToNextStatement();
      return null;
    }
    let message: string | null = null;
    this.skipInlineWhitespace();
    const maybeMessage = this.readIdentifier();
    if (maybeMessage === "message") message = this.readString();
    else if (maybeMessage) this.recoverToNextStatement();
    return { level, operator: operator as PulseDashboardCondition["operator"], value: parseConditionValue(rawValue), message };
  }

  private readOptionalHeight(): PulseDashboardRow["height"] {
    const checkpoint = this.position;
    this.skipWhitespace();
    const keyword = this.readIdentifier();
    if (keyword !== "height") {
      this.position = checkpoint;
      return "md";
    }
    const value = this.readIdentifier();
    if (value === "sm" || value === "md" || value === "lg") return value;
    this.error(checkpoint, 'Row height must be "sm", "md", or "lg"');
    return "md";
  }

  private readOptionalSpan(): number | null {
    const checkpoint = this.position;
    this.skipWhitespace();
    const keyword = this.readIdentifier();
    if (keyword !== "span") {
      this.position = checkpoint;
      return null;
    }
    this.skipWhitespace();
    const start = this.position;
    const raw = this.readWhile(/[0-9]/);
    const span = Number(raw);
    if (!Number.isInteger(span) || span < 1 || span > 12) {
      this.error(start, "Span must be an integer between 1 and 12");
      return null;
    }
    return span;
  }

  private readOpenBrace(): boolean {
    this.skipWhitespace();
    if (this.peek() !== "{") return false;
    this.advance();
    return true;
  }

  private readIdentifier(): string {
    this.skipWhitespace();
    return this.readWhile(/[A-Za-z0-9_-]/);
  }

  private tryReadString(): string | null {
    const checkpoint = this.position;
    const value = this.readString();
    if (value === null) this.position = checkpoint;
    return value;
  }

  private readBareOrString(): string | null {
    this.skipWhitespace();
    const quoted = this.tryReadString();
    if (quoted !== null) return quoted;
    const value = this.readWhile(/[^\s,}]/);
    return value || null;
  }

  private readOperator(): string {
    const first = this.peek();
    if ((first === ">" || first === "<" || first === "!" || first === "=") && this.input[this.position.index + 1] === "=") {
      const value = `${first}=`;
      this.advance();
      this.advance();
      return value;
    }
    if (first === ">" || first === "<" || first === "=") return this.advance();
    return "";
  }

  private readString(): string | null {
    this.skipWhitespace();
    if (this.peek() !== '"') return null;
    this.advance();
    let value = "";
    while (!this.isEnd()) {
      const char = this.advance();
      if (char === '"') return value;
      if (char === "\\") {
        const next = this.advance();
        value += next === "n" ? "\n" : next === "t" ? "\t" : next;
      } else {
        value += char;
      }
    }
    this.error(this.position, "Unterminated string");
    return null;
  }

  private readTripleString(): string {
    this.advance();
    this.advance();
    this.advance();
    let value = "";
    while (!this.isEnd()) {
      if (this.startsWith('"""')) {
        this.advance();
        this.advance();
        this.advance();
        return value;
      }
      value += this.advance();
    }
    this.error(this.position, "Unterminated triple-quoted string");
    return value;
  }

  private readLine(): string {
    let value = "";
    while (!this.isEnd()) {
      const char = this.peek();
      if (char === "\n" || char === "\r" || char === "}") return value;
      value += this.advance();
    }
    return value;
  }

  private recoverToNextStatement() {
    while (!this.isEnd()) {
      const char = this.peek();
      if (char === "\n" || char === "}") return;
      this.advance();
    }
  }

  private skipWhitespace() {
    while (!this.isEnd()) {
      const char = this.peek();
      if (char === "#") {
        this.readLine();
        continue;
      }
      if (char === "/" && this.input[this.position.index + 1] === "/") {
        this.readLine();
        continue;
      }
      if (!/\s/.test(char)) return;
      this.advance();
    }
  }

  private skipInlineWhitespace() {
    while (!this.isEnd()) {
      const char = this.peek();
      if (char !== " " && char !== "\t") return;
      this.advance();
    }
  }

  private readWhile(pattern: RegExp): string {
    let value = "";
    while (!this.isEnd() && pattern.test(this.peek())) value += this.advance();
    return value;
  }

  private startsWith(value: string): boolean {
    return this.input.startsWith(value, this.position.index);
  }

  private peek(): string {
    return this.input[this.position.index] ?? "";
  }

  private isEnd(): boolean {
    return this.position.index >= this.input.length;
  }

  private advance(): string {
    const char = this.input[this.position.index] ?? "";
    this.position = {
      index: this.position.index + 1,
      line: char === "\n" ? this.position.line + 1 : this.position.line,
      column: char === "\n" ? 1 : this.position.column + 1,
    };
    return char;
  }

  private error(position: Position, message: string) {
    this.diagnostics.push({ severity: "error", message, line: position.line, column: position.column });
  }
}

const parseConditionValue = (value: string): string | number | boolean => {
  if (value === "true") return true;
  if (value === "false") return false;
  const numeric = Number(value);
  return Number.isFinite(numeric) && value.trim() !== "" ? numeric : value;
};

export const parseDashboardDsl = (input: string): Result<DashboardDslDocument> => new Parser(input).parse();
