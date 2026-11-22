import { PASSWORD_WORDS } from "./_password-words";
import { randomIndex } from "./crypto";

const PASSWORD_UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const PASSWORD_LOWERCASE = "abcdefghijklmnopqrstuvwxyz";
const PASSWORD_DIGITS = "0123456789";
const PASSWORD_SYMBOLS = "!@#$%^&*()-_=+[]{}<>?";
const PASSWORD_WORD_SET = new Set(PASSWORD_WORDS);

export type PasswordStrength = {
  /** Estimated entropy in bits */
  entropy: number;
  /** Score from 0-4: 0=very weak, 1=weak, 2=fair, 3=strong, 4=very strong */
  score: 0 | 1 | 2 | 3 | 4;
  /** Human-readable label */
  label: "very weak" | "weak" | "fair" | "strong" | "very strong";
  /** Estimated crack time at 10 billion guesses/second */
  crackTime: string;
  /** Actionable feedback messages */
  feedback: string[];
};

export type RandomPasswordOptions = {
  length?: number;
  uppercase?: boolean;
  numbers?: boolean;
  symbols?: boolean;
};

export type MemorablePasswordOptions = {
  words?: number;
  capitalize?: boolean;
  fullWords?: boolean;
  separator?: string;
  addNumber?: boolean;
  addSymbol?: boolean;
};

export type PinPasswordOptions = {
  length?: number;
};

/**
 * Picks a single character from `source` at a cryptographically random position.
 *
 * @param source - Non-empty string to pick from
 */
const randomPick = (source: string): string => {
  if (source.length === 0) throw new Error("Cannot pick from empty string");
  return source[randomIndex(source.length)]!;
};

/**
 * Picks a word at random from the built-in PASSWORD_WORDS list.
 */
const randomPickWord = (): string => {
  if (PASSWORD_WORDS.length === 0) throw new Error("Password word list is empty");
  return PASSWORD_WORDS[randomIndex(PASSWORD_WORDS.length)]!;
};

/**
 * Inserts `value` at a random position in `parts`.
 * WARNING: MUTATES the input array in place.
 *
 * @param parts - Array to insert into (mutated)
 * @param value - Value to insert
 */
const insertPartAtRandomPosition = (parts: string[], value: string): void => {
  parts.splice(randomIndex(parts.length + 1), 0, value);
};

/**
 * Floors and clamps finite numbers, falling back for NaN and infinities.
 */
const boundedInt = (value: number | undefined, fallback: number, min: number, max: number): number => {
  const next = value ?? fallback;
  if (!Number.isFinite(next)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(next)));
};

/**
 * Returns true when `chars` contains at least one character from `pool`.
 */
const hasCharFromPool = (chars: readonly string[], pool: string): boolean => chars.some((char) => pool.includes(char));

/**
 * Generates a random password from configurable character pools.
 * Always includes at least one character from each enabled pool (lowercase is always enabled).
 * Length is clamped to [4, 64]; defaults to 20.
 *
 * @param options - Password configuration
 * @example
 * generateRandomPassword(); // 20-char password: lowercase + uppercase + digits
 * generateRandomPassword({ length: 32, symbols: true });
 */
const generateRandomPassword = (options: RandomPasswordOptions = {}): string => {
  const length = boundedInt(options.length, 20, 4, 64);
  const uppercase = options.uppercase ?? true;
  const numbers = options.numbers ?? true;
  const symbols = options.symbols ?? false;
  const pools: string[] = [PASSWORD_LOWERCASE];
  if (uppercase) pools.push(PASSWORD_UPPERCASE);
  if (numbers) pools.push(PASSWORD_DIGITS);
  if (symbols) pools.push(PASSWORD_SYMBOLS);

  const allChars = pools.join("");
  let chars: string[];
  do {
    chars = Array.from({ length }, () => randomPick(allChars));
  } while (!pools.every((pool) => hasCharFromPool(chars, pool)));

  return chars.join("");
};

/**
 * Transforms a word for use in a memorable password.
 * When `fullWords` is false, truncates to 3-5 characters.
 * When `capitalize` is true, uppercases the first letter.
 *
 * @param word - Raw word to transform
 * @param options - Transformation flags
 */
const transformMemorableWord = (word: string, options: Required<Pick<MemorablePasswordOptions, "capitalize" | "fullWords">>): string => {
  // slice(0, n) safely clamps to word.length, so short words (< 3 chars) return as-is
  const base = options.fullWords ? word : word.slice(0, Math.max(3, Math.min(5, word.length)));
  return options.capitalize ? `${base[0]?.toUpperCase() ?? ""}${base.slice(1)}` : base;
};

/**
 * Generates a human-readable password from random dictionary words.
 * Word count is clamped to [3, 10]; defaults to 4 words joined by the separator.
 * Optional digit and symbol (from the set "._+!") can be inserted at random positions.
 *
 * @param options - Password configuration
 * @example
 * generateMemorablePassword(); // "correct-horse-battery-staple"
 * generateMemorablePassword({ capitalize: true, addNumber: true }); // "Correct-Horse-7-Battery-Staple"
 */
const generateMemorablePassword = (options: MemorablePasswordOptions = {}): string => {
  const words = boundedInt(options.words, 4, 3, 10);
  const capitalize = options.capitalize ?? false;
  const fullWords = options.fullWords ?? true;
  const separator = options.separator ?? "-";
  const addNumber = options.addNumber ?? false;
  const addSymbol = options.addSymbol ?? false;
  const readableSymbols = "._+!";
  const parts = Array.from({ length: words }, () => transformMemorableWord(randomPickWord(), { capitalize, fullWords }));
  if (addNumber) insertPartAtRandomPosition(parts, randomPick(PASSWORD_DIGITS));
  if (addSymbol) insertPartAtRandomPosition(parts, randomPick(readableSymbols));
  return parts.join(separator);
};

/**
 * Generates a digit-only PIN code.
 * Length is clamped to [3, 12]; defaults to 6 digits.
 *
 * @param options - PIN configuration
 * @example generatePin(); // "384729"
 */
const generatePin = (options: PinPasswordOptions = {}): string => {
  const length = boundedInt(options.length, 6, 3, 12);
  return Array.from({ length }, () => randomPick(PASSWORD_DIGITS)).join("");
};

/**
 * Common password patterns to penalize during strength analysis.
 */
const COMMON_PATTERNS = [
  "password",
  "123456",
  "12345678",
  "qwerty",
  "abc123",
  "letmein",
  "admin",
  "welcome",
  "monkey",
  "master",
  "dragon",
  "login",
  "passw0rd",
  "hello",
  "shadow",
  "sunshine",
  "trustno1",
  "iloveyou",
  "batman",
  "football",
  "baseball",
  "soccer",
  "hockey",
  "michael",
  "charlie",
  "000000",
  "111111",
  "121212",
  "654321",
  "1234567890",
  "qwerty123",
  "qwertyuiop",
  "1q2w3e4r",
  "1qaz2wsx",
  "zaq1xsw2",
];

type PassphraseEntropyEstimate = {
  entropy: number;
  wordCount: number;
};

/**
 * Estimates diceware-style passphrases from separator-delimited words.
 */
const estimatePassphraseEntropy = (pw: string): PassphraseEntropyEstimate | undefined => {
  if (!/[^a-z0-9]/i.test(pw)) return undefined;

  const parts = pw.split(/[^a-z0-9]+/i).filter(Boolean);
  const words = parts.filter((part) => /^[A-Z]?[a-z]{2,}$/.test(part));
  const extras = parts.length - words.length;
  if (words.length < 3) return undefined;
  if (extras > 0 && !parts.every((part) => /^[A-Z]?[a-z]{2,}$/.test(part) || /^\d$/.test(part))) return undefined;

  const normalizedWords = words.map((word) => word.toLowerCase());
  const knownWords = normalizedWords.filter((word) => PASSWORD_WORD_SET.has(word)).length;
  const knownWordRatio = knownWords / words.length;
  const uniqueWordRatio = new Set(normalizedWords).size / words.length;

  let entropy = words.length * Math.log2(PASSWORD_WORDS.length);
  entropy += extras * Math.log2(10);
  if (knownWords > 0 && knownWordRatio < 1) entropy *= Math.max(0.5, knownWordRatio);
  if (uniqueWordRatio < 1) entropy *= Math.max(0.25, uniqueWordRatio);

  return { entropy, wordCount: words.length };
};

/**
 * Counts occurrences of sequential character runs (ascending or descending)
 * of length 3 or more in the given string.
 *
 * @param s - Input string
 * @returns Number of sequential runs detected
 */
const countSequentialRuns = (s: string): number => {
  let count = 0;
  for (let i = 0; i < s.length - 2; i++) {
    const a = s.charCodeAt(i);
    const b = s.charCodeAt(i + 1);
    const c = s.charCodeAt(i + 2);
    if ((b - a === 1 && c - b === 1) || (a - b === 1 && b - c === 1)) {
      count++;
    }
  }
  return count;
};

/**
 * Counts occurrences of 4 or more consecutive identical characters.
 *
 * @param s - Input string
 * @returns Number of repeated-character runs detected
 */
const countRepeatedRuns = (s: string): number => {
  let count = 0;
  let i = 0;
  while (i < s.length) {
    let runLen = 1;
    while (i + runLen < s.length && s[i + runLen] === s[i]) {
      runLen++;
    }
    if (runLen >= 4) count++;
    i += runLen;
  }
  return count;
};

/**
 * Formats a duration in seconds into a human-readable crack-time string.
 *
 * @param seconds - Duration to format
 * @returns Human-readable time string (e.g. "3 hours", "2 centuries")
 */
const formatCrackTime = (seconds: number): string => {
  if (!isFinite(seconds) || seconds >= 3.156e15) return "centuries";
  if (seconds < 1) return "instant";
  if (seconds < 60) return `${Math.round(seconds)} seconds`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} hours`;
  if (seconds < 2.628e6) return `${Math.round(seconds / 86400)} days`;
  if (seconds < 3.156e7) return `${Math.round(seconds / 2.628e6)} months`;
  if (seconds < 3.156e9) return `${Math.round(seconds / 3.156e7)} years`;
  return "centuries";
};

/**
 * Analyzes a password and returns its estimated strength.
 *
 * Calculates entropy based on the character pool implied by which character
 * classes are present, then applies penalties for common patterns, sequential
 * runs, and repeated characters.
 *
 * @param pw - Password to analyze
 * @returns PasswordStrength assessment
 * @example
 * checkPasswordStrength("abc");
 * // { entropy: ~14, score: 0, label: "very weak", crackTime: "instant", feedback: [...] }
 */
const checkPasswordStrength = (pw: string): PasswordStrength => {
  const feedback: string[] = [];

  if (pw.length === 0) {
    return { entropy: 0, score: 0, label: "very weak", crackTime: "instant", feedback: ["Use at least 12 characters"] };
  }

  // Detect character classes present
  const hasLower = /[a-z]/.test(pw);
  const hasUpper = /[A-Z]/.test(pw);
  const hasDigit = /[0-9]/.test(pw);
  const hasSymbol = /[^a-zA-Z0-9]/.test(pw);

  // Calculate pool size based on classes used
  let poolSize = 0;
  if (hasLower) poolSize += 26;
  if (hasUpper) poolSize += 26;
  if (hasDigit) poolSize += 10;
  if (hasSymbol) poolSize += 33;

  // Fallback: if somehow no class matched, use full pool
  if (poolSize === 0) poolSize = 95;

  // Base entropy
  let entropy = pw.length * Math.log2(poolSize);
  const passphraseEntropy = estimatePassphraseEntropy(pw);
  if (passphraseEntropy) {
    entropy = Math.min(entropy, passphraseEntropy.entropy);
  }

  // Count active classes
  const classCount = [hasLower, hasUpper, hasDigit, hasSymbol].filter(Boolean).length;

  // Penalty: all same character class
  if (classCount === 1) {
    entropy *= 0.8;
  }

  // Penalty: common patterns
  const lower = pw.toLowerCase();
  for (const pattern of COMMON_PATTERNS) {
    if (lower.includes(pattern)) {
      entropy *= 0.5;
      break;
    }
  }

  // Penalty: sequential characters. Cap was previously 0.5, allowing very
  // long sequences like "abcdefghijklmnopqrstuvwxyz" to still score high.
  // Hard-cap entropy when the sequence is long relative to overall length.
  const seqCount = countSequentialRuns(pw);
  if (seqCount > 0) {
    const seqRatio = seqCount / Math.max(pw.length, 1);
    const seqCap = seqRatio > 0.6 ? 0.2 : seqRatio > 0.3 ? 0.4 : 0.5;
    entropy *= Math.max(seqCap, 1 - seqCount * 0.1);
  }

  // Penalty: repeated characters. Penalize based on the fraction of the
  // password that is in long single-character runs — was previously a flat
  // per-run multiplier that left "a".repeat(48)+"A1!" scoring as very strong.
  const repCount = countRepeatedRuns(pw);
  let maxRunLen = 0;
  {
    let i = 0;
    while (i < pw.length) {
      let runLen = 1;
      while (i + runLen < pw.length && pw[i + runLen] === pw[i]) runLen++;
      if (runLen > maxRunLen) maxRunLen = runLen;
      i += runLen;
    }
  }
  if (repCount > 0) {
    const repRatio = repCount / Math.max(pw.length, 1);
    const repCap = repRatio > 0.6 ? 0.2 : repRatio > 0.3 ? 0.4 : 0.5;
    entropy *= Math.max(repCap, 1 - repCount * 0.15);
  }
  // Dominant single-character run: 50%+ of the password is one repeated char.
  if (maxRunLen / Math.max(pw.length, 1) > 0.5) {
    // Cap entropy at the score-2 boundary (60) so the password can never
    // reach 'strong' or 'very strong' regardless of charset.
    entropy = Math.min(entropy, 35);
  }

  entropy = Math.max(0, entropy);

  // Feedback messages
  if (pw.length < 12) feedback.push("Use at least 12 characters");
  if (passphraseEntropy) {
    if (passphraseEntropy.wordCount < 6) feedback.push("Use more random words");
  } else {
    if (!hasUpper) feedback.push("Add uppercase letters");
    if (!hasDigit) feedback.push("Add numbers");
    if (!hasSymbol) feedback.push("Add symbols (!@#$%...)");
  }
  if (seqCount > 0) feedback.push("Avoid sequential patterns (abc, 123)");
  if (repCount > 0) feedback.push("Avoid repeated characters");

  // Score thresholds
  let score: PasswordStrength["score"];
  if (entropy < 28) score = 0;
  else if (entropy < 36) score = 1;
  else if (entropy < 60) score = 2;
  else if (entropy < 80) score = 3;
  else score = 4;

  const labels: Record<PasswordStrength["score"], PasswordStrength["label"]> = {
    0: "very weak",
    1: "weak",
    2: "fair",
    3: "strong",
    4: "very strong",
  };

  // Crack time: 2^entropy / 10_000_000_000 guesses per second
  const guessesPerSecond = 1e10;
  const totalGuesses = Math.pow(2, entropy);
  const crackSeconds = totalGuesses / guessesPerSecond;
  const crackTime = formatCrackTime(crackSeconds);

  // Clear feedback for strong passwords (score 4)
  if (score === 4) feedback.length = 0;

  return { entropy: Math.round(entropy * 100) / 100, score, label: labels[score], crackTime, feedback };
};

export const password = {
  random: generateRandomPassword,
  memorable: generateMemorablePassword,
  pin: generatePin,
  strength: checkPasswordStrength,
} as const;
