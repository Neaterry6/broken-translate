'use strict';

/**
 * broken-translate — zero-dependency translation.
 *
 * Wraps the MyMemory translation API using the built-in global `fetch`, so there
 * are no dependencies to install and nothing to keep updated. Node 18+ only,
 * because that's when `fetch` became a global.
 *
 *   const { translate } = require('broken-translate');
 *   await translate('Hello world', { to: 'fr' });   // "Bonjour le monde"
 */

const ENDPOINT = 'https://api.mymemory.translated.net/get';

/** MyMemory rejects anything longer than this in a single request. */
const MAX_CHARS = 500;

/** Codes MyMemory understands for "work it out yourself". */
const AUTODETECT = new Set(['auto', 'autodetect', 'detect', '']);

/**
 * Thrown for every failure this package can identify, so callers can branch on
 * `.code` instead of string-matching an error message.
 */
class TranslateError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = 'TranslateError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/**
 * Normalise a language input into something MyMemory accepts.
 * @param {string|undefined} value
 * @param {string} fallback
 * @returns {string}
 */
function normaliseLang(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const v = String(value).trim().toLowerCase();
  if (AUTODETECT.has(v)) return 'autodetect';
  return v;
}

/**
 * Translate text.
 *
 * @param {string} text The text to translate.
 * @param {object} [options]
 * @param {string} [options.to='en'] Target language code.
 * @param {string} [options.from='autodetect'] Source code. Defaults to autodetect.
 * @param {string} [options.email] Optional contact email — MyMemory gives a much
 *   higher daily quota when one is supplied.
 * @param {number} [options.timeoutMs=15000]
 * @param {number} [options.retries=2] Retries on rate-limit / server errors.
 * @returns {Promise<{text: string, detectedLanguage: string|null, match: number|null, from: string, to: string}>}
 */
async function translate(text, options = {}) {
  const {
    to = 'en',
    from = 'autodetect',
    email,
    timeoutMs = 15000,
    retries = 2,
  } = options;

  if (typeof text !== 'string' || !text.trim()) {
    throw new TranslateError('translate() needs a non-empty string.', 'EMPTY_INPUT');
  }
  if (text.length > MAX_CHARS) {
    throw new TranslateError(
      `Text is ${text.length} chars; the API limit is ${MAX_CHARS}. Split it with translateBatch().`,
      'TOO_LONG'
    );
  }

  const source = normaliseLang(from, 'autodetect');
  const target = normaliseLang(to, 'en');

  if (target === 'autodetect') {
    throw new TranslateError(
      "The target language can't be autodetect — pass a real code like 'fr' or 'en'.",
      'BAD_TARGET'
    );
  }

  const params = new URLSearchParams({ q: text, langpair: `${source}|${target}` });
  if (email) params.set('de', email);
  const url = `${ENDPOINT}?${params.toString()}`;

  let lastError;
  let retriedWithDetected = false;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await attemptFetch(url, { source, target, timeoutMs, inputText: text });
    } catch (err) {
      lastError = err;

      // The service echoed the input back. It usually still told us what
      // language it thought the text was in, so retry once naming that language
      // explicitly — that is what turns 'hello world' into 'Salut, le monde'.
      if (err.code === 'SAME_AS_INPUT' && !retriedWithDetected) {
        const guess = err.details && err.details.detectedLanguage;
        if (guess && guess !== target) {
          retriedWithDetected = true;
          const retryParams = new URLSearchParams({ q: text, langpair: `${guess}|${target}` });
          if (email) retryParams.set('de', email);
          try {
            const out = await attemptFetch(`${ENDPOINT}?${retryParams.toString()}`, {
              source: guess,
              target,
              timeoutMs,
              inputText: text,
            });
            return out;
          } catch (retryErr) {
            lastError = retryErr;
            // If the retry also came back unchanged, stop here and let the
            // final block below raise NO_TRANSLATION. Re-throwing the inner
            // error would surface SAME_AS_INPUT, which is an internal detail.
            if (retryErr.code === 'SAME_AS_INPUT') break;
          }
        }
      }

      // Only retry things that can plausibly succeed on a second try.
      const retryable = err.code === 'RATE_LIMITED' || err.code === 'SERVER_ERROR' || err.code === 'NETWORK';
      if (!retryable || attempt === retries) throw err;
      // Small backoff: 400ms, 800ms, ...
      await sleep(400 * Math.pow(2, attempt));
    }
  }

  // Reached only when every attempt echoed the input back. Say so plainly
  // rather than returning the input as though it were a translation.
  if (lastError && lastError.code === 'SAME_AS_INPUT') {
    throw new TranslateError(
      `The translation service could not translate this text to '${target}'. ` +
        'It returned the input unchanged. Try naming the source language explicitly ' +
        "with { from: 'en' }, or rephrase the text.",
      'NO_TRANSLATION',
      lastError.details
    );
  }
  throw lastError;
}

/**
 * One request attempt.
 * @private
 */
async function attemptFetch(url, { source, target, timeoutMs, inputText }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new TranslateError(`Translation timed out after ${timeoutMs}ms.`, 'TIMEOUT');
    }
    throw new TranslateError(`Could not reach the translation service: ${err.message}`, 'NETWORK');
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429) {
    throw new TranslateError('Rate limited by the translation service. Slow down or add an email for a bigger quota.', 'RATE_LIMITED');
  }
  if (res.status >= 500) {
    throw new TranslateError(`Translation service returned ${res.status}.`, 'SERVER_ERROR');
  }
  if (!res.ok) {
    throw new TranslateError(`Translation service returned ${res.status}.`, 'HTTP_ERROR', res.status);
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw new TranslateError('Translation service returned something that is not JSON.', 'BAD_RESPONSE');
  }

  // MyMemory reports quota exhaustion in the body with a 200 status.
  if (body.quotaFinished) {
    throw new TranslateError(
      'Daily quota exhausted. Add an email option for a much larger free allowance.',
      'QUOTA_EXCEEDED'
    );
  }

  const translated = body?.responseData?.translatedText;
  const status = Number(body?.responseStatus);

  if (status && status !== 200) {
    throw new TranslateError(
      String(body?.responseDetails || 'Translation failed.'),
      status === 403 ? 'QUOTA_EXCEEDED' : 'API_ERROR',
      body?.responseDetails
    );
  }

  if (typeof translated !== 'string' || !translated.trim()) {
    throw new TranslateError('Translation service returned an empty result.', 'EMPTY_RESULT', body);
  }

  // The API sometimes hands back an error string in the translatedText field.
  if (/^(PLEASE SELECT|INVALID|NO QUERY SPECIFIED|MYMEMORY WARNING)/i.test(translated)) {
    throw new TranslateError(translated, 'API_ERROR', translated);
  }

  const detected = body?.responseData?.detectedLanguage
    || (source === 'autodetect' ? null : source);

  // MyMemory does not fail loudly when it cannot translate. It returns the
  // input unchanged with a 200 and a match of ~0.85, which previously looked
  // like a successful translation. Identity translations (match=1) are
  // legitimate — words like 'pizza', 'hotel', 'Tokyo' are the same across
  // languages — so gate the throw on a low match value rather than raw
  // equality.
  const match = typeof body?.responseData?.match === 'number'
    ? body.responseData.match : null;
  if (inputText !== undefined && sameText(translated, inputText) && match !== null && match < 0.9) {
    throw new TranslateError(
      'The translation service returned the input unchanged with a low match score, so nothing was translated.',
      'SAME_AS_INPUT',
      { detectedLanguage: detected || null }
    );
  }

  return {
    text: translated,
    detectedLanguage: detected || null,
    match,
    from: source,
    to: target,
  };
}

/**
 * True when two strings are the same ignoring case, surrounding space and
 * repeated internal whitespace. Used only to spot a no-op translation.
 * @private
 */
function sameText(a, b) {
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Detect the language of a piece of text.
 *
 * Works by translating to English and reading back what the API decided the
 * source was — MyMemory has no dedicated detection endpoint.
 *
 * @param {string} text
 * @param {object} [options] Same options as translate().
 * @returns {Promise<string|null>} A language code, or null if it couldn't tell.
 */
async function detectLanguage(text, options = {}) {
  const result = await translate(text, { ...options, to: options.to || 'en' });
  return result.detectedLanguage || null;
}

/**
 * Translate many strings, chunked to respect the per-request character limit.
 *
 * @param {string[]} texts
 * @param {object} [options] Same options as translate(), plus:
 * @param {number} [options.concurrency=3] How many requests to run at once.
 * @returns {Promise<Array<{text: string, detectedLanguage: string|null, match: number|null}>>}
 */
async function translateBatch(texts, options = {}) {
  if (!Array.isArray(texts)) {
    throw new TranslateError('translateBatch() needs an array of strings.', 'BAD_INPUT');
  }
  const { concurrency = 3, ...rest } = options;
  const limit = Math.max(1, Math.min(10, Number(concurrency) || 1));
  const results = new Array(texts.length);

  let cursor = 0;
  async function worker() {
    while (cursor < texts.length) {
      const index = cursor++;
      results[index] = await translate(texts[index], rest);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, texts.length) }, worker));
  return results;
}

/**
 * Translate a long string by splitting it on sentence/paragraph boundaries and
 * reassembling the parts. Use this when the input exceeds MAX_CHARS.
 *
 * @param {string} text
 * @param {object} [options] Same options as translate().
 * @returns {Promise<{text: string, parts: number, detectedLanguage: string|null}>}
 */
async function translateLong(text, options = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new TranslateError('translateLong() needs a non-empty string.', 'EMPTY_INPUT');
  }
  if (text.length <= MAX_CHARS) {
    const r = await translate(text, options);
    return { text: r.text, parts: 1, detectedLanguage: r.detectedLanguage };
  }

  const chunks = splitText(text, MAX_CHARS);
  const results = await translateBatch(chunks, options);
  return {
    text: results.map((r) => r.text).join(' '),
    parts: chunks.length,
    detectedLanguage: results[0]?.detectedLanguage || null,
  };
}

/**
 * Split text into chunks no longer than `max`, preferring paragraph then
 * sentence then word boundaries so translations read naturally.
 *
 * @param {string} text
 * @param {number} [max=500]
 * @returns {string[]}
 */
function splitText(text, max = MAX_CHARS) {
  const chunks = [];
  const paragraphs = text.split(/\n{2,}/);

  for (const para of paragraphs) {
    if (para.length <= max) {
      if (para.trim()) chunks.push(para.trim());
      continue;
    }
    // Split the paragraph into sentences, then pack them greedily.
    const sentences = para.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [para];
    let current = '';
    for (const sentence of sentences) {
      if (sentence.length > max) {
        if (current) { chunks.push(current.trim()); current = ''; }
        // A single monster sentence: fall back to word packing.
        let words = '';
        for (const word of sentence.split(/\s+/)) {
          if (!word) continue;

          // A single token longer than the limit (a URL, a base64 blob, a long
          // identifier) can never fit. Hard-split it, or the API call fails.
          if (word.length > max) {
            if (words.trim()) { chunks.push(words.trim()); words = ''; }
            for (let i = 0; i < word.length; i += max) {
              chunks.push(word.slice(i, i + max));
            }
            continue;
          }

          if ((words + ' ' + word).trim().length > max) {
            if (words.trim()) chunks.push(words.trim());
            words = word;
          } else {
            words = words ? `${words} ${word}` : word;
          }
        }
        if (words.trim()) chunks.push(words.trim());
        continue;
      }
      if ((current + sentence).length > max) {
        if (current.trim()) chunks.push(current.trim());
        current = sentence;
      } else {
        current += sentence;
      }
    }
    if (current.trim()) chunks.push(current.trim());
  }

  return chunks.length ? chunks : [text.slice(0, max)];
}

/**
 * A short list of common language codes, for convenience.
 * The API supports many more — this is just the common set.
 */
const LANGUAGES = Object.freeze({
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian',
  pt: 'Portuguese', nl: 'Dutch', ru: 'Russian', pl: 'Polish', tr: 'Turkish',
  ar: 'Arabic', hi: 'Hindi', bn: 'Bengali', ur: 'Urdu', fa: 'Persian',
  zh: 'Chinese', ja: 'Japanese', ko: 'Korean', th: 'Thai', vi: 'Vietnamese',
  id: 'Indonesian', ms: 'Malay', sw: 'Swahili', ha: 'Hausa', yo: 'Yoruba',
  ig: 'Igbo', am: 'Amharic', zu: 'Zulu', af: 'Afrikaans', el: 'Greek',
  he: 'Hebrew', sv: 'Swedish', no: 'Norwegian', da: 'Danish', fi: 'Finnish',
  cs: 'Czech', ro: 'Romanian', hu: 'Hungarian', uk: 'Ukrainian', ta: 'Tamil',
});

/** @private */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  translate,
  translateBatch,
  translateLong,
  detectLanguage,
  splitText,
  TranslateError,
  LANGUAGES,
  MAX_CHARS,
};
