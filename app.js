// Recall — app shell: persistence (IndexedDB), settings (localStorage),
// routing, and view rendering.

import { PROVIDERS, generateDeck, tutorReply } from './llm.js';
import {
  newSrsState,
  schedule,
  dueQueue,
  isDue,
  previewInterval,
  formatDue,
  GRADES,
} from './srs.js';

// --- pdf.js worker setup -----------------------------------------------------
// The lib is loaded as a module in index.html and attaches to window.
const PDFJS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168';
function pdfjs() {
  return window.pdfjsLib || (window['pdfjs-dist/build/pdf'] || null);
}

// --- IndexedDB ---------------------------------------------------------------
const DB_NAME = 'recall-db';
const STORE = 'decks';
let _db = null;

function openDb() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      _db = req.result;
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

async function dbAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function dbGet(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(deck) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(deck);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- settings (localStorage) -------------------------------------------------
const SETTINGS_KEY = 'recall-settings';

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const s = raw ? JSON.parse(raw) : {};
    return {
      provider: s.provider || 'anthropic',
      model: s.model || PROVIDERS[s.provider || 'anthropic'].defaultModel,
      keys: s.keys || {}, // { anthropic: '...', openai: '...' }
    };
  } catch (_) {
    return { provider: 'anthropic', model: PROVIDERS.anthropic.defaultModel, keys: {} };
  }
}

function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

let settings = loadSettings();

function activeKey() {
  return settings.keys[settings.provider] || '';
}

function hasKey() {
  return Boolean(activeKey());
}

// --- helpers -----------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');
const toastEl = $('#toast');

let toastTimer = null;
function toast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.className = 'toast';
  }, isError ? 4500 : 2500);
}

function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function dueCount(deck, now = new Date()) {
  return (deck.flashcards || []).filter((c) => isDue(c, now)).length;
}

// --- routing -----------------------------------------------------------------
// Hash-based: #/  #/create  #/settings  #/deck/<id>
function parseRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  const parts = hash.split('/').filter(Boolean);
  if (parts.length === 0) return { view: 'home' };
  if (parts[0] === 'create') return { view: 'create' };
  if (parts[0] === 'settings') return { view: 'settings' };
  if (parts[0] === 'deck' && parts[1]) return { view: 'deck', id: parts[1], tab: parts[2] || 'study' };
  return { view: 'home' };
}

function go(path) {
  location.hash = path;
}

window.addEventListener('hashchange', render);

function setActiveNav(view) {
  document.querySelectorAll('.nav-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
  });
}

document.querySelectorAll('.nav-btn').forEach((b) => {
  b.addEventListener('click', () => {
    const v = b.dataset.view;
    go(v === 'home' ? '/' : `/${v}`);
  });
});

// --- render dispatcher -------------------------------------------------------
async function render() {
  const route = parseRoute();
  setActiveNav(route.view === 'deck' ? 'home' : route.view);
  app.innerHTML = '<div class="center muted" style="padding:2rem">Loading…</div>';

  try {
    if (route.view === 'home') return renderHome();
    if (route.view === 'create') return renderCreate();
    if (route.view === 'settings') return renderSettings();
    if (route.view === 'deck') return renderDeck(route.id, route.tab);
  } catch (err) {
    console.error(err);
    app.innerHTML = `<div class="panel"><h2>Something went wrong</h2><p>${esc(err.message)}</p></div>`;
  }
}

// --- view: home (deck list) --------------------------------------------------
async function renderHome() {
  const decks = await dbAll();
  decks.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  if (decks.length === 0) {
    app.innerHTML = `
      <div class="empty">
        <h2>No decks yet</h2>
        <p>Paste a topic, your notes, or a PDF and Recall will build flashcards and a quiz.</p>
        <div style="margin-top:1.25rem"><button class="btn primary" id="cta">Create your first deck</button></div>
      </div>`;
    $('#cta').addEventListener('click', () => go('/create'));
    return;
  }

  const now = new Date();
  const totalDue = decks.reduce((n, d) => n + dueCount(d, now), 0);

  app.innerHTML = `
    <div class="study-head" style="margin-bottom:1.25rem">
      <h1>Your decks</h1>
      <button class="btn primary" id="new-deck">New deck</button>
    </div>
    ${totalDue > 0 ? `<p class="muted" style="margin-top:-0.75rem">${totalDue} card${totalDue === 1 ? '' : 's'} due for review across all decks.</p>` : ''}
    <div class="deck-grid">
      ${decks.map((d) => deckCardHtml(d, now)).join('')}
    </div>`;

  $('#new-deck').addEventListener('click', () => go('/create'));
  app.querySelectorAll('.deck-card').forEach((el) => {
    el.addEventListener('click', () => go(`/deck/${el.dataset.id}`));
  });
}

function deckCardHtml(d, now) {
  const due = dueCount(d, now);
  const cards = (d.flashcards || []).length;
  const quiz = (d.quiz || []).length;
  return `
    <button class="deck-card" data-id="${esc(d.id)}">
      <h3>${esc(d.title)}</h3>
      <div class="deck-meta">
        <span>${cards} card${cards === 1 ? '' : 's'}</span>
        <span>${quiz} quiz Q</span>
      </div>
      <div>${due > 0 ? `<span class="badge due">${due} due</span>` : '<span class="badge">all caught up</span>'}</div>
    </button>`;
}

// --- view: create ------------------------------------------------------------
function renderCreate() {
  app.innerHTML = `
    <button class="back-link" id="back">← Decks</button>
    <h1>New deck</h1>
    <p class="muted" style="margin-top:-0.5rem">Give Recall something to learn from: a topic, your notes, or a PDF.</p>

    <div class="panel stack" style="margin-top:1.25rem">
      <div class="field">
        <label for="material">Topic or notes</label>
        <textarea id="material" placeholder="e.g. 'The causes of World War I' — or paste your lecture notes here…"></textarea>
        <p class="hint">For a broad topic, a sentence is enough. For your own notes, paste as much as you like.</p>
      </div>

      <div class="field">
        <label for="pdf">…or upload a PDF</label>
        <input type="file" id="pdf" accept="application/pdf" />
        <p class="hint" id="pdf-status"></p>
      </div>

      <div class="row">
        <div class="field">
          <label for="cards">Flashcards</label>
          <input type="number" id="cards" value="12" min="3" max="40" />
        </div>
        <div class="field">
          <label for="qs">Quiz questions</label>
          <input type="number" id="qs" value="6" min="0" max="20" />
        </div>
      </div>

      <div class="btn-row">
        <button class="btn primary" id="generate">Generate deck</button>
      </div>
      ${!hasKey() ? '<p class="hint" style="color:var(--danger)">No API key set — add one in Settings before generating.</p>' : ''}
    </div>`;

  $('#back').addEventListener('click', () => go('/'));

  const pdfInput = $('#pdf');
  const pdfStatus = $('#pdf-status');
  const materialEl = $('#material');

  pdfInput.addEventListener('change', async () => {
    const file = pdfInput.files?.[0];
    if (!file) return;
    pdfStatus.innerHTML = '<span class="spinner"></span> Extracting text…';
    try {
      const text = await extractPdfText(file);
      if (!text.trim()) {
        pdfStatus.textContent = 'No selectable text found (is this a scanned image PDF?).';
        return;
      }
      materialEl.value = text;
      pdfStatus.textContent = `Loaded ${text.length.toLocaleString()} characters from ${file.name}.`;
    } catch (err) {
      console.error(err);
      pdfStatus.textContent = 'Could not read that PDF.';
    }
  });

  $('#generate').addEventListener('click', async () => {
    const material = materialEl.value.trim();
    const cardCount = Math.max(3, Math.min(40, parseInt($('#cards').value, 10) || 12));
    const quizCount = Math.max(0, Math.min(20, parseInt($('#qs').value, 10) || 6));

    if (!material) return toast('Add a topic, notes, or a PDF first.', true);
    if (!hasKey()) {
      toast('Set an API key in Settings first.', true);
      return go('/settings');
    }

    const btn = $('#generate');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Generating…';

    try {
      const result = await generateDeck({
        provider: settings.provider,
        apiKey: activeKey(),
        model: settings.model,
        material,
        cardCount,
        quizCount,
      });

      const deck = {
        id: uid(),
        title: result.title,
        material,
        flashcards: result.flashcards.map((c) => ({
          id: uid(),
          front: c.front,
          back: c.back,
          srs: newSrsState(),
        })),
        quiz: result.quiz,
        chat: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await dbPut(deck);
      toast('Deck created.');
      go(`/deck/${deck.id}`);
    } catch (err) {
      console.error(err);
      toast(err.message, true);
      btn.disabled = false;
      btn.textContent = 'Generate deck';
    }
  });
}

async function extractPdfText(file) {
  const lib = pdfjs();
  if (!lib) throw new Error('PDF library not loaded yet.');
  lib.GlobalWorkerOptions.workerSrc = `${PDFJS_CDN}/pdf.worker.min.mjs`;
  const buf = await file.arrayBuffer();
  const pdf = await lib.getDocument({ data: buf }).promise;
  let out = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    out += content.items.map((it) => it.str).join(' ') + '\n\n';
  }
  return out;
}

// --- view: deck --------------------------------------------------------------
async function renderDeck(id, tab) {
  const deck = await dbGet(id);
  if (!deck) {
    app.innerHTML = '<div class="panel"><h2>Deck not found</h2><p>It may have been deleted.</p></div>';
    return;
  }

  const tabs = [
    ['study', 'Review'],
    ['cards', 'Cards'],
    ['quiz', 'Quiz'],
    ['tutor', 'Tutor'],
  ];

  app.innerHTML = `
    <button class="back-link" id="back">← Decks</button>
    <div class="study-head">
      <h1>${esc(deck.title)}</h1>
      <button class="btn danger sm" id="del">Delete deck</button>
    </div>
    <div class="tabs">
      ${tabs.map(([k, label]) => `<button class="tab ${k === tab ? 'active' : ''}" data-tab="${k}">${label}${k === 'study' && dueCount(deck) > 0 ? ` (${dueCount(deck)})` : ''}</button>`).join('')}
    </div>
    <div id="tab-body"></div>`;

  $('#back').addEventListener('click', () => go('/'));
  $('#del').addEventListener('click', async () => {
    if (confirm(`Delete "${deck.title}"? This can't be undone.`)) {
      await dbDelete(id);
      toast('Deck deleted.');
      go('/');
    }
  });

  app.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => go(`/deck/${id}/${t.dataset.tab}`));
  });

  const body = $('#tab-body');
  if (tab === 'study') renderStudyTab(deck, body);
  else if (tab === 'cards') renderCardsTab(deck, body);
  else if (tab === 'quiz') renderQuizTab(deck, body);
  else if (tab === 'tutor') renderTutorTab(deck, body);
}

// --- deck tab: study (spaced repetition) -------------------------------------
function renderStudyTab(deck, body) {
  let queue = dueQueue(deck.flashcards);
  const total = queue.length;
  let done = 0;
  let flipped = false;

  if (total === 0) {
    const next = nextDueCard(deck);
    body.innerHTML = `
      <div class="empty">
        <h2>All caught up 🎉</h2>
        <p>${next ? `Your next card is ${formatDue(next.srs.due)}.` : 'No cards in this deck yet.'}</p>
        <div style="margin-top:1rem"><button class="btn" id="cram">Review all anyway</button></div>
      </div>`;
    $('#cram')?.addEventListener('click', () => {
      queue = [...deck.flashcards].sort(() => Math.random() - 0.5);
      if (queue.length) step();
    });
    return;
  }

  step();

  function step() {
    if (queue.length === 0) {
      body.innerHTML = `
        <div class="empty">
          <h2>Session complete</h2>
          <p>You reviewed ${done} card${done === 1 ? '' : 's'}.</p>
          <div class="btn-row center" style="justify-content:center;margin-top:1rem">
            <button class="btn" id="again">Review again</button>
          </div>
        </div>`;
      $('#again').addEventListener('click', () => renderStudyTab(deck, body));
      return;
    }

    const card = queue[0];
    flipped = false;
    const reviewed = total === 0 ? done : done;
    const pct = total ? Math.round((reviewed / (total || 1)) * 100) : 0;

    body.innerHTML = `
      <div class="study-head">
        <span class="muted">${queue.length} left</span>
        <span class="muted">${done} done</span>
      </div>
      <div class="progress"><span style="width:${pct}%"></span></div>
      <div class="flashcard" id="card">
        <div class="fc-label">Front</div>
        <div class="fc-text">${esc(card.front)}</div>
        <div class="fc-tap">tap to reveal · or press space</div>
      </div>
      <div id="grades"></div>`;

    const cardEl = $('#card');
    cardEl.addEventListener('click', flip);

    function flip() {
      if (flipped) return;
      flipped = true;
      cardEl.innerHTML = `
        <div class="fc-label">Back</div>
        <div class="fc-text">${esc(card.back)}</div>`;
      cardEl.style.cursor = 'default';
      $('#grades').innerHTML = `
        <div class="grade-row">
          ${Object.keys(GRADES).map((g) => `
            <button class="grade-btn ${g}" data-grade="${g}">
              <span class="g-label">${GRADES[g].label}</span>
              <span class="g-when">${previewInterval(card.srs, g)}</span>
            </button>`).join('')}
        </div>`;
      $('#grades').querySelectorAll('.grade-btn').forEach((b) => {
        b.addEventListener('click', () => grade(b.dataset.grade));
      });
    }

    async function grade(g) {
      card.srs = schedule(card.srs, g);
      deck.updatedAt = Date.now();
      await dbPut(deck);
      queue.shift();
      done++;
      step();
    }

    // keyboard: space flips; 1-4 grades
    const onKey = (e) => {
      if (e.key === ' ') {
        e.preventDefault();
        if (!flipped) flip();
      } else if (flipped && ['1', '2', '3', '4'].includes(e.key)) {
        const map = ['again', 'hard', 'good', 'easy'];
        grade(map[parseInt(e.key, 10) - 1]);
      }
    };
    document.addEventListener('keydown', onKey, { once: false });
    // Clean up listener when leaving — attach to body for GC via hashchange render.
    cardEl._cleanup = () => document.removeEventListener('keydown', onKey);
  }
}

function nextDueCard(deck) {
  const sorted = [...(deck.flashcards || [])].sort(
    (a, b) => new Date(a.srs.due) - new Date(b.srs.due)
  );
  return sorted[0] || null;
}

// --- deck tab: cards (browse all) --------------------------------------------
function renderCardsTab(deck, body) {
  if (!deck.flashcards.length) {
    body.innerHTML = '<div class="empty"><p>No flashcards in this deck.</p></div>';
    return;
  }
  const now = new Date();
  body.innerHTML = `
    <div class="panel">
      ${deck.flashcards.map((c) => `
        <div class="list-item">
          <div>
            <div class="li-front">${esc(c.front)}</div>
            <div class="li-back">${esc(c.back)}</div>
          </div>
          <div class="li-due">${isDue(c, now) ? 'due now' : esc(formatDue(c.srs.due, now))}</div>
        </div>`).join('')}
    </div>`;
}

// --- deck tab: quiz ----------------------------------------------------------
function renderQuizTab(deck, body) {
  const quiz = deck.quiz || [];
  if (!quiz.length) {
    body.innerHTML = '<div class="empty"><p>This deck has no quiz questions.</p></div>';
    return;
  }

  let idx = 0;
  let score = 0;
  const answers = new Array(quiz.length).fill(null);

  step();

  function step() {
    if (idx >= quiz.length) {
      body.innerHTML = `
        <div class="empty">
          <h2>${score} / ${quiz.length} correct</h2>
          <p>${score === quiz.length ? 'Perfect run.' : score >= quiz.length * 0.7 ? 'Nicely done.' : 'Keep reviewing those flashcards.'}</p>
          <div style="margin-top:1rem"><button class="btn" id="retry">Retake quiz</button></div>
        </div>`;
      $('#retry').addEventListener('click', () => renderQuizTab(deck, body));
      return;
    }

    const q = quiz[idx];
    const pct = Math.round((idx / quiz.length) * 100);
    body.innerHTML = `
      <div class="study-head">
        <span class="muted">Question ${idx + 1} of ${quiz.length}</span>
        <span class="muted">Score ${score}</span>
      </div>
      <div class="progress"><span style="width:${pct}%"></span></div>
      <div class="panel">
        <div class="quiz-q">${esc(q.question)}</div>
        <div class="options">
          ${q.options.map((opt, i) => `<button class="option" data-i="${i}">${esc(opt)}</button>`).join('')}
        </div>
        <div id="post"></div>
      </div>`;

    const optionEls = body.querySelectorAll('.option');
    optionEls.forEach((el) => {
      el.addEventListener('click', () => choose(parseInt(el.dataset.i, 10), optionEls));
    });
  }

  function choose(choice, optionEls) {
    const q = quiz[idx];
    answers[idx] = choice;
    const correct = choice === q.answerIndex;
    if (correct) score++;

    optionEls.forEach((el) => {
      const i = parseInt(el.dataset.i, 10);
      el.disabled = true;
      if (i === q.answerIndex) el.classList.add('correct');
      else if (i === choice) el.classList.add('wrong');
    });

    $('#post').innerHTML = `
      ${q.explanation ? `<div class="explain">${esc(q.explanation)}</div>` : ''}
      <div class="btn-row" style="margin-top:1rem">
        <button class="btn primary" id="next">${idx + 1 < quiz.length ? 'Next question' : 'See results'}</button>
      </div>`;
    $('#next').addEventListener('click', () => {
      idx++;
      step();
    });
  }
}

// --- deck tab: tutor ---------------------------------------------------------
function renderTutorTab(deck, body) {
  body.innerHTML = `
    <div class="panel">
      <h2 style="margin-bottom:0.25rem">Ask the tutor</h2>
      <p class="muted" style="margin-top:0">Questions about this material — answered with the notes you generated the deck from.</p>
      <div class="chat" id="chat"></div>
      <div class="chat-input">
        <input type="text" id="chat-in" placeholder="Ask a follow-up question…" ${hasKey() ? '' : 'disabled'} />
        <button class="btn primary" id="send" ${hasKey() ? '' : 'disabled'}>Send</button>
      </div>
      ${!hasKey() ? '<p class="hint" style="color:var(--danger)">Set an API key in Settings to chat.</p>' : ''}
    </div>`;

  const chatEl = $('#chat');
  const input = $('#chat-in');
  const sendBtn = $('#send');

  function paint() {
    if (!deck.chat.length) {
      chatEl.innerHTML = '<p class="muted center" style="margin:auto">Try: "Explain this more simply" or "Give me an example."</p>';
      return;
    }
    chatEl.innerHTML = deck.chat
      .map((m) => `<div class="msg ${m.role}">${esc(m.content)}</div>`)
      .join('');
    chatEl.scrollTop = chatEl.scrollHeight;
  }
  paint();

  async function send() {
    const text = input.value.trim();
    if (!text) return;
    if (!hasKey()) return go('/settings');

    deck.chat.push({ role: 'user', content: text });
    input.value = '';
    paint();

    chatEl.insertAdjacentHTML('beforeend', '<div class="msg assistant" id="thinking"><span class="spinner"></span></div>');
    chatEl.scrollTop = chatEl.scrollHeight;
    sendBtn.disabled = true;
    input.disabled = true;

    try {
      const reply = await tutorReply({
        provider: settings.provider,
        apiKey: activeKey(),
        model: settings.model,
        material: deck.material,
        history: deck.chat.map((m) => ({ role: m.role, content: m.content })),
      });
      deck.chat.push({ role: 'assistant', content: reply });
      deck.updatedAt = Date.now();
      await dbPut(deck);
    } catch (err) {
      deck.chat.push({ role: 'assistant', content: `⚠️ ${err.message}` });
    } finally {
      $('#thinking')?.remove();
      sendBtn.disabled = false;
      input.disabled = false;
      input.focus();
      paint();
    }
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
  });
}

// --- view: settings ----------------------------------------------------------
function renderSettings() {
  const p = PROVIDERS[settings.provider];

  app.innerHTML = `
    <button class="back-link" id="back">← Decks</button>
    <h1>Settings</h1>
    <p class="muted" style="margin-top:-0.5rem">Your key is stored only in this browser and sent directly to the provider. There is no server.</p>

    <div class="panel stack" style="margin-top:1.25rem">
      <div class="field">
        <label for="provider">Provider</label>
        <select id="provider">
          ${Object.entries(PROVIDERS).map(([k, v]) => `<option value="${k}" ${k === settings.provider ? 'selected' : ''}>${v.label}</option>`).join('')}
        </select>
      </div>

      <div class="field">
        <label for="model">Model</label>
        <select id="model">
          ${p.models.map((m) => `<option value="${m}" ${m === settings.model ? 'selected' : ''}>${m}</option>`).join('')}
        </select>
      </div>

      <div class="field">
        <label for="key">API key <span class="muted" id="key-prov">(${esc(p.label)})</span></label>
        <input type="password" id="key" placeholder="${esc(p.keyHint)}" value="${esc(settings.keys[settings.provider] || '')}" autocomplete="off" />
        <p class="hint">Get one at <a href="${esc(p.keyUrl)}" id="key-url" target="_blank" rel="noopener">${esc(p.keyUrl)}</a>. Stored in localStorage on this device only.</p>
      </div>

      <div class="btn-row">
        <button class="btn primary" id="save">Save</button>
        <button class="btn ghost" id="clear">Clear this key</button>
      </div>
    </div>

    <div class="panel" style="margin-top:1rem">
      <h2>About</h2>
      <p>Recall builds flashcards and quizzes from a topic, your notes, or a PDF, then schedules reviews with an SM-2-style spaced-repetition algorithm. Everything is stored locally in your browser.</p>
    </div>`;

  $('#back').addEventListener('click', () => go('/'));

  const providerSel = $('#provider');
  const modelSel = $('#model');
  const keyInput = $('#key');

  providerSel.addEventListener('change', () => {
    const newProv = providerSel.value;
    const np = PROVIDERS[newProv];
    modelSel.innerHTML = np.models
      .map((m) => `<option value="${m}" ${m === np.defaultModel ? 'selected' : ''}>${m}</option>`)
      .join('');
    keyInput.value = settings.keys[newProv] || '';
    keyInput.placeholder = np.keyHint;
    $('#key-prov').textContent = `(${np.label})`;
    const urlEl = $('#key-url');
    urlEl.textContent = np.keyUrl;
    urlEl.href = np.keyUrl;
  });

  $('#save').addEventListener('click', () => {
    const provider = providerSel.value;
    const model = modelSel.value;
    const key = keyInput.value.trim();
    settings.provider = provider;
    settings.model = model;
    settings.keys = { ...settings.keys, [provider]: key };
    saveSettings(settings);
    toast('Settings saved.');
  });

  $('#clear').addEventListener('click', () => {
    const provider = providerSel.value;
    settings.keys = { ...settings.keys, [provider]: '' };
    keyInput.value = '';
    saveSettings(settings);
    toast('Key cleared.');
  });
}

// --- boot --------------------------------------------------------------------
render();
