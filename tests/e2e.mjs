#!/usr/bin/env node
// Recall — free end-to-end test against Google Gemini.
//
// This makes ONE minimal, real LLM call using the SAME request/response shape
// the app uses for its OpenAI-compatible providers (see the `openai`/`gemini`
// branch in llm.js), pointed at Google Gemini's OpenAI-compatible endpoint.
// Because Gemini has a generous free tier, this proves Recall's request/parse
// logic works against a real model at ~zero cost.
//
// It is a plain Node fetch (no browser), so there is no CORS concern here — the
// test is the reliable free path regardless of any in-browser restrictions.
//
// Usage:
//   GEMINI_API_KEY=AIza... node tests/e2e.mjs
//   GEMINI_API_KEY=AIza... GEMINI_MODEL=gemini-2.5-flash node tests/e2e.mjs
//
// Get a free key at https://aistudio.google.com/apikey
// If GEMINI_API_KEY is unset, the test prints SKIP and exits 0.
//
// Default model is gemini-2.0-flash. If your key's project has retired that
// model (Gemini returns a 404 "no longer available"), set GEMINI_MODEL to a
// current free model such as gemini-2.5-flash.

const ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

function fail(reason) {
  console.error(`FAIL: ${reason}`);
  process.exit(1);
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.log(
      'SKIP: GEMINI_API_KEY not set. Get a free key at https://aistudio.google.com/apikey'
    );
    process.exit(0);
  }

  // Same request shape app.js/llm.js builds for OpenAI-compatible providers.
  const body = {
    model: MODEL,
    messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
    max_tokens: 20,
  };

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    fail(`network error: ${err.message}`);
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    fail(`response was not valid JSON: ${err.message}`);
  }

  if (!res.ok) {
    // Gemini's OpenAI-compatible endpoint wraps errors as [{ error: {...} }].
    const errObj = Array.isArray(data) ? data[0] : data;
    const msg =
      errObj && errObj.error
        ? typeof errObj.error === 'string'
          ? errObj.error
          : errObj.error.message
        : `HTTP ${res.status}`;
    fail(`Gemini error ${res.status}: ${msg}`);
  }

  // Same extraction path the app uses: data.choices[0].message.content
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || text.trim().length === 0) {
    fail('response parsed but contained no non-empty assistant text.');
  }

  console.log(`Model replied: ${JSON.stringify(text.trim())}`);
  console.log('PASS');
  process.exit(0);
}

main();
