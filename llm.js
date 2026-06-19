// LLM provider abstraction for Recall.
//
// Browser-only, bring-your-own-key. The user's key lives in localStorage and is
// sent directly from the browser to the chosen provider — never to any server
// of ours (there is no server). Anthropic requires the
// `anthropic-dangerous-direct-browser-access` header to permit a browser-origin
// request; OpenAI works with a plain fetch.

export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    defaultModel: 'claude-sonnet-4-6',
    models: [
      'claude-opus-4-8',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ],
    keyHint: 'sk-ant-...',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  openai: {
    label: 'OpenAI (GPT)',
    defaultModel: 'gpt-4o',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini'],
    keyHint: 'sk-...',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
};

// --- low-level chat call -----------------------------------------------------
// messages: [{ role: 'user'|'assistant', content: string }]
// system:   optional system prompt string
// returns:  assistant text (string)
async function chat({ provider, apiKey, model, system, messages, maxTokens = 4096 }) {
  if (!apiKey) throw new Error('No API key set. Add one in Settings.');

  if (provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        messages,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(providerError(data) || `Anthropic error ${res.status}`);
    }
    const text = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return text;
  }

  if (provider === 'openai') {
    const oaMessages = system
      ? [{ role: 'system', content: system }, ...messages]
      : messages;
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: oaMessages,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(providerError(data) || `OpenAI error ${res.status}`);
    }
    return data.choices?.[0]?.message?.content || '';
  }

  throw new Error(`Unknown provider: ${provider}`);
}

function providerError(data) {
  if (!data) return null;
  if (data.error) {
    return typeof data.error === 'string' ? data.error : data.error.message;
  }
  return null;
}

// --- JSON extraction ---------------------------------------------------------
// Models occasionally wrap JSON in prose or ```json fences. Pull out the first
// well-formed JSON object/array.
function extractJson(text) {
  if (!text) throw new Error('Empty response from model.');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;

  try {
    return JSON.parse(candidate.trim());
  } catch (_) {
    // Fall back: find the outermost braces/brackets.
    const start = candidate.search(/[[{]/);
    const lastObj = candidate.lastIndexOf('}');
    const lastArr = candidate.lastIndexOf(']');
    const end = Math.max(lastObj, lastArr);
    if (start === -1 || end === -1 || end < start) {
      throw new Error('Could not parse JSON from the model response.');
    }
    return JSON.parse(candidate.slice(start, end + 1));
  }
}

// --- deck generation ---------------------------------------------------------
const GEN_SYSTEM = `You are Recall, a study-aid generator. From the user's study material you produce flashcards and a multiple-choice quiz.

Return ONLY a JSON object (no prose, no markdown fences) with this exact shape:
{
  "title": "A short 2-6 word title for this deck",
  "flashcards": [ { "front": "question or prompt", "back": "concise answer" } ],
  "quiz": [
    {
      "question": "the question",
      "options": ["A", "B", "C", "D"],
      "answerIndex": 0,
      "explanation": "one sentence on why the answer is correct"
    }
  ]
}

Rules:
- Write clear, self-contained cards. Each front should be answerable without seeing the others.
- Cover the breadth of the material, not just the first paragraph.
- Quiz: exactly 4 options each, exactly one correct, "answerIndex" is 0-based.
- Keep answers and explanations concise and factual. Do not invent facts beyond the material; for a broad topic, use well-established general knowledge.`;

export async function generateDeck({
  provider,
  apiKey,
  model,
  material,
  cardCount = 12,
  quizCount = 6,
}) {
  const trimmed = material.trim();
  if (trimmed.length < 3) throw new Error('Please provide some material to study.');

  // Guard against very large inputs blowing the context / cost.
  const MAX_CHARS = 60000;
  const source = trimmed.length > MAX_CHARS ? trimmed.slice(0, MAX_CHARS) : trimmed;

  const prompt = `Create about ${cardCount} flashcards and ${quizCount} multiple-choice questions from the study material below.

STUDY MATERIAL:
"""
${source}
"""`;

  const text = await chat({
    provider,
    apiKey,
    model,
    system: GEN_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 8000,
  });

  const parsed = extractJson(text);
  const flashcards = Array.isArray(parsed.flashcards) ? parsed.flashcards : [];
  const quiz = Array.isArray(parsed.quiz) ? parsed.quiz : [];

  const cleanCards = flashcards
    .filter((c) => c && c.front && c.back)
    .map((c) => ({ front: String(c.front), back: String(c.back) }));

  const cleanQuiz = quiz
    .filter(
      (q) =>
        q &&
        q.question &&
        Array.isArray(q.options) &&
        q.options.length >= 2 &&
        Number.isInteger(q.answerIndex) &&
        q.answerIndex >= 0 &&
        q.answerIndex < q.options.length
    )
    .map((q) => ({
      question: String(q.question),
      options: q.options.map(String),
      answerIndex: q.answerIndex,
      explanation: q.explanation ? String(q.explanation) : '',
    }));

  if (cleanCards.length === 0 && cleanQuiz.length === 0) {
    throw new Error('The model returned no usable cards. Try different or longer material.');
  }

  return {
    title: parsed.title ? String(parsed.title) : 'Untitled deck',
    flashcards: cleanCards,
    quiz: cleanQuiz,
  };
}

// --- tutor chat --------------------------------------------------------------
export async function tutorReply({ provider, apiKey, model, material, history }) {
  const context = (material || '').slice(0, 30000);
  const system = `You are a patient, precise tutor helping a student understand their study material. Answer their questions clearly and concisely. When relevant, ground your answer in the material below. If a question goes beyond the material, answer from general knowledge but say so.

STUDY MATERIAL (for reference):
"""
${context}
"""`;

  return chat({
    provider,
    apiKey,
    model,
    system,
    messages: history,
    maxTokens: 2000,
  });
}
