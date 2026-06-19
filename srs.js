// Spaced-repetition scheduling, SM-2 variant.
//
// Each card stores its scheduling state in a `srs` object:
//   ease         multiplier on the interval (starts 2.5, floor 1.3)
//   intervalDays current interval in days (can be fractional for sub-day steps)
//   reps         number of consecutive successful reviews
//   due          ISO timestamp of when the card is next due
//   lapses       how many times the card has been forgotten
//   reviews      count of total reviews

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_EASE = 1.3;

// A fresh card is due immediately so it shows up in the first session.
export function newSrsState() {
  return {
    ease: 2.5,
    intervalDays: 0,
    reps: 0,
    due: new Date().toISOString(),
    lapses: 0,
    reviews: 0,
  };
}

// Grades the front-end exposes. Map to SM-2 quality scores.
export const GRADES = {
  again: { label: 'Again', quality: 0 },
  hard: { label: 'Hard', quality: 3 },
  good: { label: 'Good', quality: 4 },
  easy: { label: 'Easy', quality: 5 },
};

// Apply a grade to a card's srs state and return the next state.
// `now` is injectable for testing; defaults to the current time.
export function schedule(state, grade, now = new Date()) {
  const s = { ...(state || newSrsState()) };
  s.reviews = (s.reviews || 0) + 1;

  if (grade === 'again') {
    // Lapse: reset progress, see it again in ~10 minutes, drop ease.
    s.reps = 0;
    s.lapses = (s.lapses || 0) + 1;
    s.ease = Math.max(MIN_EASE, s.ease - 0.2);
    s.intervalDays = 10 / (24 * 60); // 10 minutes expressed in days
    s.due = new Date(now.getTime() + s.intervalDays * DAY_MS).toISOString();
    return s;
  }

  // Successful recall of some quality.
  s.reps = (s.reps || 0) + 1;

  if (s.reps === 1) {
    s.intervalDays = grade === 'easy' ? 3 : 1;
  } else if (s.reps === 2) {
    s.intervalDays = grade === 'easy' ? 10 : 6;
  } else {
    let mult = s.ease;
    if (grade === 'hard') mult = 1.2;
    if (grade === 'easy') mult = s.ease * 1.3;
    s.intervalDays = Math.round(Math.max(1, s.intervalDays) * mult);
  }

  // Adjust ease per grade.
  if (grade === 'hard') s.ease = Math.max(MIN_EASE, s.ease - 0.15);
  if (grade === 'easy') s.ease = s.ease + 0.15;

  s.due = new Date(now.getTime() + s.intervalDays * DAY_MS).toISOString();
  return s;
}

// Is the card due at `now`?
export function isDue(card, now = new Date()) {
  const due = card?.srs?.due;
  if (!due) return true;
  return new Date(due).getTime() <= now.getTime();
}

// Cards due now, most-overdue first.
export function dueQueue(cards, now = new Date()) {
  return cards
    .filter((c) => isDue(c, now))
    .sort((a, b) => new Date(a.srs.due) - new Date(b.srs.due));
}

// Human-friendly "next due" preview for a grade, shown on the rating buttons.
export function previewInterval(state, grade, now = new Date()) {
  const next = schedule(state, grade, now);
  const days = next.intervalDays;
  if (days < 1) {
    const mins = Math.round(days * 24 * 60);
    return `${mins}m`;
  }
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

export function formatDue(due, now = new Date()) {
  const diff = new Date(due).getTime() - now.getTime();
  if (diff <= 0) return 'due now';
  const days = diff / DAY_MS;
  if (days < 1 / 24) return 'in <1h';
  if (days < 1) return `in ${Math.round(days * 24)}h`;
  if (days < 30) return `in ${Math.round(days)}d`;
  if (days < 365) return `in ${Math.round(days / 30)}mo`;
  return `in ${(days / 365).toFixed(1)}y`;
}
