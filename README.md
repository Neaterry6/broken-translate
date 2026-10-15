# broken-translate

**Zero-dependency translation for Node.** Auto-detect, batch, and long-text support using the built-in `fetch`. No axios, no SDK, nothing to install but this.

```bash
npm install broken-translate
```

## Why this exists

The usual way to translate in Node is to pull in an HTTP client and a provider SDK, then babysit the versions. This package uses the `fetch` that already ships with Node 18+, so the dependency count is **zero** and there is nothing to keep updated.

**0 dependencies. Node 18+. Full TypeScript types included.**

## Quick start

```js
const { translate } = require('broken-translate');

const r = await translate('Hello world', { to: 'fr' });
console.log(r.text); // "Bonjour le monde"
```

Source language is auto-detected, so you usually only pass `to`.

```js
await translate('Bonjour mon ami', { to: 'en' }); // "Hello my friend"
await translate('Good morning', { to: 'yo' });    // Yoruba
```

ESM works too:

```js
import { translate } from 'broken-translate';
```

## API

### `translate(text, options?)`

Returns `{ text, detectedLanguage, match, from, to }`.

| option | default | what it does |
|---|---|---|
| `to` | `'en'` | target language code |
| `from` | `'autodetect'` | source code — leave it and let the API work it out |
| `email` | — | **raises your daily quota a lot.** Pass your email. |
| `timeoutMs` | `15000` | per-request timeout |
| `retries` | `2` | retries on rate-limit / server / network errors |

### `detectLanguage(text, options?)`

Returns a language code, or `null` if it couldn't tell.

```js
await detectLanguage('Bonjour mon ami'); // 'fr'
```

### `translateBatch(texts, options?)`

Translates an array concurrently, **preserving input order**.

```js
const out = await translateBatch(['one', 'two', 'three'], { to: 'es', concurrency: 3 });
out[1].text; // translation of 'two'
```

`concurrency` defaults to 3 and is capped at 10 — be kind to a free API.

### `translateLong(text, options?)`

For text longer than one request allows. Splits on paragraph → sentence → word boundaries, translates the parts, and rejoins them.

```js
const { text, parts } = await translateLong(bigArticle, { to: 'fr' });
console.log(`translated in ${parts} parts`);
```

### `splitText(text, max?)`

The chunker on its own, if you want to inspect or cache the pieces.

```js
splitText('First para.\n\nSecond para.', 500);
// ['First para.', 'Second para.']
```

Never returns a chunk longer than `max`, even for a single unbroken 1000-character token.

### `LANGUAGES`

A frozen map of common codes to names, for building pickers.

```js
LANGUAGES.fr; // 'French'
LANGUAGES.yo; // 'Yoruba'
```

### `TranslateError`

Every failure throws this, so you branch on `.code` instead of matching strings.

| code | meaning |
|---|---|
| `EMPTY_INPUT` | you passed empty text |
| `TOO_LONG` | over `MAX_CHARS` — use `translateLong` |
| `BAD_TARGET` | target was `autodetect` |
| `BAD_INPUT` | `translateBatch` got a non-array |
| `RATE_LIMITED` | HTTP 429 — slow down |
| `QUOTA_EXCEEDED` | daily allowance used up |
| `TIMEOUT` | exceeded `timeoutMs` |
| `NETWORK` | couldn't reach the service |
| `SERVER_ERROR` | 5xx from upstream |
| `BAD_RESPONSE` | body wasn't JSON |
| `EMPTY_RESULT` | upstream returned nothing usable |
| `API_ERROR` | upstream reported a problem |

```js
try {
  await translate(text, { to: 'fr' });
} catch (err) {
  if (err.code === 'QUOTA_EXCEEDED') {
    // fall back to a cached translation, or tell the user to retry tomorrow
  }
  if (err.code === 'TOO_LONG') {
    await translateLong(text, { to: 'fr' });
  }
}
```

## Quota

The upstream service is free and rate-limited. Two things help a lot:

1. **Pass your email.** The free daily allowance jumps substantially.
2. **Cache.** You're billed per request, so don't re-translate the same string.

```js
const cache = new Map();

async function cachedTranslate(text, to) {
  const key = `${to}:${text}`;
  if (cache.has(key)) return cache.get(key);
  const r = await translate(text, { to, email: 'you@example.com' });
  cache.set(key, r);
  return r;
}
```

## Common patterns

**Translate a whole file**

```js
const fs = require('node:fs');
const { translateLong } = require('broken-translate');

const source = fs.readFileSync('README.md', 'utf8');
const { text } = await translateLong(source, { to: 'fr' });
fs.writeFileSync('README.fr.md', text);
```

**Bot command**

```js
if (text.startsWith('!tr ')) {
  const [, lang, ...rest] = text.split(' ');
  const r = await translate(rest.join(' '), { to: lang });
  return reply(r.text);
}
```

**Handle quota gracefully**

```js
async function safeTranslate(text, to) {
  try {
    return (await translate(text, { to })).text;
  } catch (err) {
    if (err.code === 'QUOTA_EXCEEDED') return '[translation quota reached — try later]';
    if (err.code === 'TOO_LONG') return (await translateLong(text, { to })).text;
    throw err;
  }
}
```

## Tests

```bash
npm test          # 21 offline tests, fetch stubbed, no network
npm run test:live # 5 tests against the real API
```

The default suite is fully offline and deterministic. The live suite is separate so a flaky network never turns CI red.

## TypeScript

Types ship with the package.

```ts
import { translate, TranslateError, type TranslateOptions } from 'broken-translate';

const opts: TranslateOptions = { to: 'fr', retries: 3 };
const r = await translate('hi', opts);
const s: string = r.text;
```

## Licence

MIT © Akewushola Abdulbakri Temitope (brokenvzn)
