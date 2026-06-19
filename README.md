# Recall

An AI study tool that turns any topic, your pasted notes, or a PDF into flashcards and a multiple-choice quiz, then schedules your reviews with spaced repetition. It runs entirely in the browser — there is no backend, and your study material never leaves your machine except for the calls you make to the LLM provider with your own API key.

**Live demo:** https://vansh4195.github.io/recall/

## What it does

- **Generate study material.** Paste a topic ("the French Revolution"), drop in your lecture notes, or upload a PDF. Recall extracts the text (PDFs are parsed in-browser with pdf.js) and asks the LLM to produce a deck of flashcards and a multiple-choice quiz.
- **Review with spaced repetition.** Each card is scheduled with an SM-2-style algorithm. After you flip a card you rate it Again / Hard / Good / Easy, and Recall sets the next due date accordingly. Open the app tomorrow and only the cards that are due come up.
- **Take a quiz.** The generated multiple-choice questions are graded instantly with explanations.
- **Ask the tutor.** A built-in chat lets you ask follow-up questions about the material you generated the deck from — useful when a card doesn't quite click.
- **Keep your decks.** Everything is stored locally in IndexedDB, so your decks, scheduling state, and review history persist across sessions on the same browser.

## Bring your own API key

Recall does not ship with any key and has no server to hold one. You paste your own key in Settings; it is stored in your browser's `localStorage` and sent directly from the browser to the provider you chose. It is never transmitted anywhere else.

Three providers are supported:

- **Anthropic** — uses the Messages API with the `anthropic-dangerous-direct-browser-access` header so the request can be made from a browser. Get a key at https://console.anthropic.com/. Default model: `claude-sonnet-4-6`.
- **OpenAI** — uses the Chat Completions API. Get a key at https://platform.openai.com/. Default model: `gpt-4o`.
- **Gemini (free)** — uses Google's OpenAI-compatible Chat Completions endpoint (same request shape as OpenAI, different base URL). Google offers a generous free tier, so this is the cheapest way to try Recall. Get a free key at https://aistudio.google.com/apikey. Default model: `gemini-2.0-flash`. The endpoint returns permissive CORS headers, so it works directly from the browser like the other providers.

A note on browser keys: calling a provider directly from the browser exposes your key to anyone with access to that browser session, and it counts against your own usage/billing. That trade-off is the whole point of a BYO-key, no-backend tool — keep the key to a personal machine and rotate it if you're unsure.

## Run it locally

It's a static site — no build step, no dependencies to install. Because the PDF worker and ES modules are loaded over `fetch`, you need to serve it over HTTP rather than opening the file directly.

```sh
git clone https://github.com/Vansh4195/recall.git
cd recall
python3 -m http.server 8000
# then open http://localhost:8000
```

Any static file server works (`npx serve`, `php -S localhost:8000`, etc.).

## Test for free with Gemini

You can verify Recall's LLM request/parse logic against a real model at ~zero cost using Google Gemini's free tier.

1. Get a free API key at https://aistudio.google.com/apikey.
2. Run the end-to-end test (requires Node 18+ for the built-in `fetch`):

```sh
GEMINI_API_KEY=AIza... node tests/e2e.mjs
```

It makes one tiny real call (capped at 20 tokens) through the same OpenAI-compatible request/response shape the app uses, pointed at Gemini's `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` endpoint, and prints `PASS` (exit 0) or `FAIL: <reason>` (exit non-zero). If `GEMINI_API_KEY` is unset it prints `SKIP` and exits 0. Because it's a plain Node script (no browser), there is no CORS concern — this is the reliable free path.

To use Gemini inside the app, pick **Gemini (free)** in Settings and paste the same key.

## How the spaced repetition works

Recall uses a variant of the classic SM-2 algorithm. Every card carries three numbers: an *ease factor* (starts at 2.5), an *interval* in days, and a *repetition count*.

- **Again** — the card lapsed. Repetitions reset, the interval drops to ~10 minutes, and ease is reduced.
- **Hard** — interval grows slowly (×1.2) and ease drops a little.
- **Good** — the standard path: 1 day, then 6 days, then `interval × ease` after that.
- **Easy** — a larger jump (an extra ease bonus) and ease increases.

The next due date is `now + interval`. On each session, the review queue is whatever is due now, ordered by how overdue it is.

## Project layout

```
index.html      markup and the loaded libraries (pdf.js)
styles.css      the full UI (monochrome, responsive)
app.js          state, IndexedDB persistence, routing, rendering
llm.js          provider abstraction (Anthropic + OpenAI + Gemini), prompt building
srs.js          the SM-2 scheduler
tests/e2e.mjs   free end-to-end LLM test (Gemini, OpenAI-compatible endpoint)
```

## Limitations

- Generation quality depends on the model and your input — vague topics produce vague cards.
- PDF extraction is text-only; scanned/image PDFs without an embedded text layer won't yield usable text.
- Decks live in one browser. There's no sync or account.
