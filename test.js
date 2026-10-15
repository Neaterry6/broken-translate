'use strict';

// Offline tests. Global fetch is stubbed, so these are deterministic and need no
// network. Run `npm run test:live` for the real API.
const test = require('node:test');
const assert = require('node:assert');

const t = require('./index.js');

const realFetch = global.fetch;

/** Install a stub fetch. Returns a restore function. */
function stubFetch(handler) {
  global.fetch = async (url, opts) => handler(String(url), opts);
  return () => { global.fetch = realFetch; };
}

/** Build a successful MyMemory-shaped response. */
function okResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

function successBody(text, { detected, match = 1 } = {}) {
  return {
    responseData: { translatedText: text, match, ...(detected ? { detectedLanguage: detected } : {}) },
    responseStatus: 200,
    quotaFinished: false,
  };
}

test('translate returns the translated text', async () => {
  const restore = stubFetch(() => okResponse(successBody('Bonjour le monde')));
  try {
    const r = await t.translate('Hello world', { to: 'fr' });
    assert.strictEqual(r.text, 'Bonjour le monde');
    assert.strictEqual(r.to, 'fr');
    assert.strictEqual(r.from, 'autodetect');
  } finally { restore(); }
});

test('translate defaults to English and autodetect', async () => {
  let seenUrl = '';
  const restore = stubFetch((url) => { seenUrl = url; return okResponse(successBody('hi')); });
  try {
    await t.translate('hola');
    assert.match(seenUrl, /langpair=autodetect%7Cen|langpair=autodetect\|en/);
  } finally { restore(); }
});

test('empty input is rejected without a network call', async () => {
  let called = false;
  const restore = stubFetch(() => { called = true; return okResponse(successBody('x')); });
  try {
    await assert.rejects(() => t.translate(''), (e) => e.code === 'EMPTY_INPUT');
    await assert.rejects(() => t.translate('   '), (e) => e.code === 'EMPTY_INPUT');
    await assert.rejects(() => t.translate(null), (e) => e.code === 'EMPTY_INPUT');
    assert.strictEqual(called, false, 'should not hit the network for bad input');
  } finally { restore(); }
});

test('over-long input is rejected with a helpful code', async () => {
  const huge = 'a'.repeat(t.MAX_CHARS + 1);
  await assert.rejects(() => t.translate(huge), (e) => {
    assert.strictEqual(e.code, 'TOO_LONG');
    assert.match(e.message, /translateBatch|translateLong/);
    return true;
  });
});

test('autodetect is rejected as a target', async () => {
  await assert.rejects(
    () => t.translate('hi', { to: 'autodetect' }),
    (e) => e.code === 'BAD_TARGET'
  );
});

test('429 becomes RATE_LIMITED and is retried then surfaced', async () => {
  let attempts = 0;
  const restore = stubFetch(() => { attempts++; return okResponse({}, 429); });
  try {
    await assert.rejects(
      () => t.translate('hi', { retries: 1 }),
      (e) => e.code === 'RATE_LIMITED'
    );
    assert.strictEqual(attempts, 2, 'should retry once (initial + 1)');
  } finally { restore(); }
});

test('a transient failure recovers on retry', async () => {
  let attempts = 0;
  const restore = stubFetch(() => {
    attempts++;
    if (attempts === 1) return okResponse({}, 500);
    return okResponse(successBody('recovered'));
  });
  try {
    const r = await t.translate('hi', { retries: 2 });
    assert.strictEqual(r.text, 'recovered');
    assert.strictEqual(attempts, 2);
  } finally { restore(); }
});

test('quotaFinished in the body becomes QUOTA_EXCEEDED', async () => {
  const restore = stubFetch(() => okResponse({
    responseData: { translatedText: 'x' },
    responseStatus: 200,
    quotaFinished: true,
  }));
  try {
    await assert.rejects(() => t.translate('hi'), (e) => e.code === 'QUOTA_EXCEEDED');
  } finally { restore(); }
});

test('an API error string in translatedText is not returned as success', async () => {
  const restore = stubFetch(() => okResponse(successBody('PLEASE SELECT TWO DISTINCT LANGUAGES')));
  try {
    await assert.rejects(() => t.translate('hi'), (e) => e.code === 'API_ERROR');
  } finally { restore(); }
});

test('a non-JSON body becomes BAD_RESPONSE', async () => {
  const restore = stubFetch(() => ({
    ok: true,
    status: 200,
    json: async () => { throw new Error('not json'); },
  }));
  try {
    await assert.rejects(() => t.translate('hi'), (e) => e.code === 'BAD_RESPONSE');
  } finally { restore(); }
});

test('a network failure becomes NETWORK', async () => {
  const restore = stubFetch(() => { throw new Error('ECONNREFUSED'); });
  try {
    await assert.rejects(() => t.translate('hi', { retries: 0 }), (e) => e.code === 'NETWORK');
  } finally { restore(); }
});

test('detectedLanguage is passed through', async () => {
  const restore = stubFetch(() => okResponse(successBody('Hello', { detected: 'fr' })));
  try {
    const lang = await t.detectLanguage('Bonjour');
    assert.strictEqual(lang, 'fr');
  } finally { restore(); }
});

test('translateBatch keeps input order', async () => {
  let n = 0;
  const restore = stubFetch(() => {
    const i = n++;
    return okResponse(successBody(`out${i}`));
  });
  try {
    const results = await t.translateBatch(['a', 'b', 'c'], { concurrency: 3 });
    assert.strictEqual(results.length, 3);
    assert.deepStrictEqual(results.map((r) => r.text).sort(), ['out0', 'out1', 'out2']);
  } finally { restore(); }
});

test('translateBatch rejects a non-array', async () => {
  await assert.rejects(() => t.translateBatch('nope'), (e) => e.code === 'BAD_INPUT');
});

test('translateLong short-circuits when under the limit', async () => {
  const restore = stubFetch(() => okResponse(successBody('short')));
  try {
    const r = await t.translateLong('hi', { to: 'fr' });
    assert.strictEqual(r.parts, 1);
    assert.strictEqual(r.text, 'short');
  } finally { restore(); }
});

test('translateLong splits long input and rejoins it', async () => {
  const long = ('This is a sentence. '.repeat(60)).trim(); // ~1200 chars
  assert.ok(long.length > t.MAX_CHARS);

  const restore = stubFetch((url) => {
    const q = new URL(url).searchParams.get('q');
    assert.ok(q.length <= t.MAX_CHARS, `chunk exceeded limit: ${q.length}`);
    // Return a genuinely different string. Echoing the input back is what the
    // real service does when it fails to translate, and the client now rejects
    // that as SAME_AS_INPUT — so a stub that echoes would be testing the bug.
    return okResponse(successBody('FR:' + q));
  });
  try {
    const r = await t.translateLong(long, { to: 'fr' });
    assert.ok(r.parts > 1, 'should have split into multiple parts');
    assert.ok(r.text.length > 0);
    assert.ok(r.text.startsWith('FR:'), 'the translated text should be returned');
  } finally { restore(); }
});

test('a no-op translation is not reported as success (regression)', async () => {
  // MyMemory returns the input unchanged with a 200 when it cannot translate.
  // That used to come back as a successful result: translate('hello world',
  // { to: 'fr' }) returned 'hello world'.
  const restore = stubFetch(() => okResponse(successBody('hello world', { detected: 'en', match: 0.85 })));
  try {
    await assert.rejects(
      () => t.translate('hello world', { to: 'fr' }),
      (err) => {
        assert.ok(err instanceof t.TranslateError);
        assert.strictEqual(err.code, 'NO_TRANSLATION');
        return true;
      }
    );
  } finally { restore(); }
});

test('a no-op result is retried with the detected language (regression)', async () => {
  // The first call echoes the input; the retry names the detected language and
  // succeeds. This is what turns 'hello world' into 'Salut, le monde'.
  const seen = [];
  const restore = stubFetch((url) => {
    const pair = new URL(url).searchParams.get('langpair');
    seen.push(pair);
    if (pair.startsWith('autodetect')) {
      return okResponse(successBody('hello world', { detected: 'en', match: 0.85 }));
    }
    return okResponse(successBody('Salut, le monde'));
  });
  try {
    const r = await t.translate('hello world', { to: 'fr' });
    assert.strictEqual(r.text, 'Salut, le monde');
    assert.deepStrictEqual(seen, ['autodetect|fr', 'en|fr']);
  } finally { restore(); }
});

test('identity translations with high match are not rejected (regression)', async () => {
  // Words like pizza, hotel, Tokyo are spelled the same across languages.
  // match=1 means the service considers this a genuine translation, not a
  // silent no-op. Gate the SAME_AS_INPUT throw on match < 0.9 so these keep working.
  const cases = [
    ['pizza', 'fr'],
    ['hotel', 'es'],
    ['restaurant', 'fr'],
    ['Tokyo', 'fr'],
    ['coffee', 'de'],
  ];
  for (const [word, to] of cases) {
    const restore = stubFetch(() => okResponse(successBody(word, { detected: 'en', match: 1 })));
    try {
      const r = await t.translate(word, { to });
      assert.strictEqual(r.text, word);
      assert.strictEqual(r.match, 1);
    } finally { restore(); }
  }
});

test('splitText never exceeds the max', () => {
  const text = ('word '.repeat(400)).trim();
  for (const chunk of t.splitText(text, 100)) {
    assert.ok(chunk.length <= 100, `chunk too long: ${chunk.length}`);
  }
});

test('splitText handles a monster word with no spaces', () => {
  const monster = 'x'.repeat(1200);
  const chunks = t.splitText(monster, 500);
  assert.ok(chunks.length >= 1);
  for (const c of chunks) assert.ok(c.length <= 500);
});

test('splitText prefers paragraph breaks', () => {
  const text = 'First para.\n\nSecond para.';
  assert.deepStrictEqual(t.splitText(text, 500), ['First para.', 'Second para.']);
});

test('LANGUAGES is frozen and includes common codes', () => {
  assert.ok(Object.isFrozen(t.LANGUAGES));
  assert.strictEqual(t.LANGUAGES.fr, 'French');
  assert.ok(t.LANGUAGES.yo, 'should include Yoruba');
});

test('TranslateError is a real Error with a code', () => {
  const e = new t.TranslateError('boom', 'TIMEOUT');
  assert.ok(e instanceof Error);
  assert.strictEqual(e.name, 'TranslateError');
  assert.strictEqual(e.code, 'TIMEOUT');
});
