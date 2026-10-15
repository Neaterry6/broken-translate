// ESM wrapper around the CommonJS implementation.
import mod from './index.js';

export const translate = mod.translate;
export const translateBatch = mod.translateBatch;
export const translateLong = mod.translateLong;
export const detectLanguage = mod.detectLanguage;
export const splitText = mod.splitText;
export const TranslateError = mod.TranslateError;
export const LANGUAGES = mod.LANGUAGES;
export const MAX_CHARS = mod.MAX_CHARS;

export default mod;
