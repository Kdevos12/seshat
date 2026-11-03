/**
 * A BM25 index over name, signature and gloss, the method of TheoremGraph's own search (plan Task 9): no
 * model, no embedding, rebuilt from the journal. The three fields are weighted into one term frequency
 * (BM25F without a length per field).
 */

/** The fields of a document and their weights. */
export const FIELD_WEIGHTS: Readonly<Record<string, number>> = { name: 3, signature: 2, gloss: 1 };

/**
 * The tokens of a text: words of letters and digits, with camelCase, underscores and dots as breaks,
 * lower-cased, without one-letter words (a variable's name says nothing); every other character that
 * is not a bracket or punctuation of the syntax is a token (`∣`, `≤`, `+`, `^`...), since the symbols
 * of a statement are what a search by shape looks for.
 */
export function tokenize(text: string): string[] {
  const spaced = text.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2").replace(/[_.']/g, " ");
  const tokens: string[] = [];
  for (const m of spaced.matchAll(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}()[\]{}⟨⟩:,;]/gu)) {
    const token = m[0].toLowerCase();
    if (/^\p{L}$/u.test(token)) continue;
    tokens.push(token);
  }
  return tokens;
}

export interface Bm25Document {
  id: string;
  /** Field name to text: `name`, `signature`, `gloss`. */
  fields: Readonly<Record<string, string>>;
}

export interface Bm25Options {
  k1?: number;
  b?: number;
  weights?: Readonly<Record<string, number>>;
}

export interface Scored {
  id: string;
  score: number;
}

export class Bm25Index {
  readonly size: number;
  readonly #tf: Array<Map<string, number>>;
  readonly #ids: string[];
  readonly #lengths: number[];
  readonly #df = new Map<string, number>();
  readonly #avg: number;
  readonly #k1: number;
  readonly #b: number;

  constructor(documents: readonly Bm25Document[], options: Bm25Options = {}) {
    const weights = options.weights ?? FIELD_WEIGHTS;
    this.#k1 = options.k1 ?? 1.2;
    this.#b = options.b ?? 0.75;
    this.#ids = documents.map((d) => d.id);
    this.#tf = documents.map((d) => {
      const tf = new Map<string, number>();
      for (const [field, text] of Object.entries(d.fields)) {
        const weight = weights[field] ?? 1;
        for (const token of tokenize(text)) tf.set(token, (tf.get(token) ?? 0) + weight);
      }
      return tf;
    });
    this.#lengths = this.#tf.map((tf) => [...tf.values()].reduce((a, b) => a + b, 0));
    for (const tf of this.#tf) for (const token of tf.keys()) this.#df.set(token, (this.#df.get(token) ?? 0) + 1);
    this.size = documents.length;
    this.#avg = this.size === 0 ? 0 : this.#lengths.reduce((a, b) => a + b, 0) / this.size;
  }

  /** The documents that share a term with the query, best first (ties by order of insertion). */
  search(query: string): Scored[] {
    const terms = [...new Set(tokenize(query))];
    const scored: Scored[] = [];
    this.#tf.forEach((tf, i) => {
      let score = 0;
      for (const term of terms) {
        const f = tf.get(term);
        if (f === undefined) continue;
        const n = this.#df.get(term) ?? 0;
        const idf = Math.log(1 + (this.size - n + 0.5) / (n + 0.5));
        const norm = this.#avg === 0 ? 1 : 1 - this.#b + (this.#b * (this.#lengths[i] ?? 0)) / this.#avg;
        score += (idf * f * (this.#k1 + 1)) / (f + this.#k1 * norm);
      }
      if (score > 0) scored.push({ id: this.#ids[i] as string, score });
    });
    return scored.sort((a, b) => b.score - a.score);
  }
}
