//! Ranks what the palette and pickers search. It works like a file finder: words
//! in any order must all match, letters may skip but runs and word starts count
//! most, a file's name counts more than its folders, capitals match only
//! capitals, and when nothing matches at all one mistyped letter is forgiven.

export interface Searchable {
  label: string;
  /** The label is a path. */
  path?: boolean;
  /** More text it is found by, when a word of the query is in it whole. */
  words?: string;
  /** Multiplies its score; 1 by default. */
  weight?: number;
}

export interface Found<T> {
  entry: T;
  /** Which characters of the label matched. */
  marks: ReadonlySet<number>;
}

interface Match {
  /** 1 is a whole word from its start; loose letters are near 0. */
  score: number;
  positions: number[];
}

const letter = 16;
const gapStart = 3;
const gapMore = 1;
const boundary = 8;
const camel = 6;
/** Letters scattered more loosely than this are a coincidence. */
const loosest = 0.7;

const separator = /[\s/\\._\-:,()]/;

function bonusAt(text: string, index: number): number {
  const before = text[index - 1];
  if (before === undefined || separator.test(before)) return boundary;
  const here = text[index]!;
  return (/[a-z]/.test(before) && /[A-Z]/.test(here)) || (/\D/.test(before) && /\d/.test(here)) ? camel : 0;
}

/** The best way to find a word's letters in order, or nothing. */
function match(text: string, word: string): Match | undefined {
  const exact = word !== word.toLowerCase();
  const from = exact ? text : text.toLowerCase();
  let at = -1;
  for (const char of word) {
    at = from.indexOf(char, at + 1);
    if (at < 0) return undefined;
  }

  // best[i][j]: the best score with letter i of the word at j of the text.
  const rows: number[][] = [];
  const came: number[][] = [];
  for (let i = 0; i < word.length; i++) {
    const row = Array.from<number>({ length: text.length }).fill(-Infinity);
    const back = Array.from<number>({ length: text.length }).fill(-1);
    let gap = -Infinity; // The best end of the letter before, less the gap since.
    let gapAt = -1;
    for (let j = i; j < text.length; j++) {
      const previous = rows[i - 1];
      if (previous && j >= 2 && previous[j - 2]! - gapStart >= gap - gapMore) {
        gap = previous[j - 2]! - gapStart;
        gapAt = j - 2;
      } else gap -= gapMore;
      if (from[j] !== word[i]) continue;
      const bonus = bonusAt(text, j);
      if (!previous) {
        row[j] = letter + bonus * 2;
        continue;
      }
      const run = j ? previous[j - 1]! + letter + Math.max(bonus, boundary / 2) : -Infinity;
      const jump = gap + letter + bonus;
      row[j] = Math.max(run, jump);
      back[j] = run >= jump ? j - 1 : gapAt;
    }
    rows.push(row);
    came.push(back);
  }

  const last = rows.at(-1)!;
  let end = last.indexOf(Math.max(...last));
  const top = letter * word.length + boundary * 2 + (boundary / 2) * (word.length - 1);
  const score = last[end]! / top;
  if (!Number.isFinite(score) || (word.length > 1 && score < loosest)) return undefined;
  const positions: number[] = [];
  for (let i = word.length - 1; i >= 0; i--) {
    positions.unshift(end);
    end = came[i]![end]!;
  }
  // Of equals the one that starts sooner is better.
  return { score: Math.min(1, score) - Math.min(positions[0]!, 50) / 1000, positions };
}

/** The word with each letter left out or swapped with the next: what one slip would have typed. */
const slips = (word: string) =>
  [...word].flatMap((char, index) => [
    word.slice(0, index) + word.slice(index + 1),
    ...(index + 1 < word.length
      ? [word.slice(0, index) + word[index + 1]! + char + word.slice(index + 2)]
      : []),
  ]);

const shortestSlip = 4;
function forgive(text: string, word: string): Match | undefined {
  if (word.length < shortestSlip) return undefined;
  let best: Match | undefined;
  for (const other of slips(word)) {
    const found = match(text, other);
    if (found && found.score > 0.6 && found.score > (best?.score ?? 0)) best = found;
  }
  return best && { ...best, score: best.score * 0.6 };
}

function rank<T extends Searchable>(entries: readonly T[], words: string[], find: typeof match): Found<T>[] {
  const ranked: Array<Found<T> & { score: number }> = [];
  for (const entry of entries) {
    const name = entry.path ? entry.label.lastIndexOf("/") + 1 : 0;
    const extra = entry.words?.toLowerCase() ?? "";
    const marks = new Set<number>();
    let total = 0;
    for (const word of words) {
      const whole = find(entry.label, word);
      const inName = name ? find(entry.label.slice(name), word) : undefined;
      const best = inName && inName.score >= (whole?.score ?? 0) * 0.8 ? inName : whole;
      const shift = best === inName && inName ? name : 0;
      const score = best ? best.score * (name && !shift ? 0.85 : 1) : 0;
      const said = extra.includes(word.toLowerCase()) ? 0.5 : 0;
      if (!score && !said) {
        total = -1;
        break;
      }
      total += Math.max(score, said);
      for (const position of best?.positions ?? []) marks.add(position + shift);
    }
    if (total >= 0) ranked.push({ entry, marks, score: (total / words.length) * (entry.weight ?? 1) });
  }
  // Of equals the shorter is closer to what was typed.
  return ranked.toSorted((a, b) => b.score - a.score || a.entry.label.length - b.entry.label.length);
}

/** The entries a query finds, best first; all of them, as they are, without one. */
export function search<T extends Searchable>(entries: readonly T[], query: string): Found<T>[] {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return entries.map((entry) => ({ entry, marks: new Set() }));
  const found = rank(entries, words, match);
  return found.length
    ? found
    : rank(entries, words, (text, word) => match(text, word) ?? forgive(text, word));
}

/** A label cut where marked and unmarked text meet. */
export function segments(
  label: string,
  marks: ReadonlySet<number>,
): Array<{ text: string; marked: boolean }> {
  const out: Array<{ text: string; marked: boolean }> = [];
  for (let index = 0; index < label.length; index++) {
    const marked = marks.has(index);
    const last = out.at(-1);
    if (last?.marked === marked) last.text += label[index]!;
    else out.push({ text: label[index]!, marked });
  }
  return out;
}
