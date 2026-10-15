/** Options accepted by translate(), translateBatch() and translateLong(). */
export interface TranslateOptions {
  /** Target language code, e.g. 'fr'. Default 'en'. */
  to?: string;
  /** Source language code. Default 'autodetect'. */
  from?: string;
  /** Optional contact email. MyMemory grants a much larger daily quota when set. */
  email?: string;
  /** Request timeout in ms. Default 15000. */
  timeoutMs?: number;
  /** Retries on rate-limit / server / network errors. Default 2. */
  retries?: number;
}

export interface TranslateResult {
  /** The translated text. */
  text: string;
  /** Language the API decided the source was, or null if it could not tell. */
  detectedLanguage: string | null;
  /** Translation confidence, 0-1, or null. */
  match: number | null;
  /** The source code used. */
  from: string;
  /** The target code used. */
  to: string;
}

export interface BatchOptions extends TranslateOptions {
  /** How many requests to run at once. Default 3, max 10. */
  concurrency?: number;
}

export interface LongResult {
  text: string;
  parts: number;
  detectedLanguage: string | null;
}

/** Error codes TranslateError can carry. */
export type TranslateErrorCode =
  | 'EMPTY_INPUT'
  | 'TOO_LONG'
  | 'BAD_TARGET'
  | 'BAD_INPUT'
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'SERVER_ERROR'
  | 'HTTP_ERROR'
  | 'BAD_RESPONSE'
  | 'EMPTY_RESULT'
  | 'API_ERROR';

export declare class TranslateError extends Error {
  name: 'TranslateError';
  code: TranslateErrorCode;
  details?: unknown;
  constructor(message: string, code: TranslateErrorCode, details?: unknown);
}

/** Translate a string. Throws TranslateError on failure. */
export declare function translate(text: string, options?: TranslateOptions): Promise<TranslateResult>;

/** Translate many strings concurrently. */
export declare function translateBatch(texts: string[], options?: BatchOptions): Promise<TranslateResult[]>;

/** Translate a string of any length by splitting on sentence boundaries. */
export declare function translateLong(text: string, options?: TranslateOptions): Promise<LongResult>;

/** Detect the language of a string. Returns a code, or null. */
export declare function detectLanguage(text: string, options?: TranslateOptions): Promise<string | null>;

/** Split text into API-sized chunks on natural boundaries. */
export declare function splitText(text: string, max?: number): string[];

/** Max characters per request. */
export declare const MAX_CHARS: number;

/** A convenience map of common language codes to names. */
export declare const LANGUAGES: Readonly<Record<string, string>>;

declare const _default: {
  translate: typeof translate;
  translateBatch: typeof translateBatch;
  translateLong: typeof translateLong;
  detectLanguage: typeof detectLanguage;
  splitText: typeof splitText;
  TranslateError: typeof TranslateError;
  LANGUAGES: typeof LANGUAGES;
  MAX_CHARS: typeof MAX_CHARS;
};
export default _default;
