export function tokenize(text: string): string[] {
  return text
    // split camelCase boundaries: "createAgent" -> "create Agent"
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export interface Bm25Doc {
  id: string;
  text: string;
}

export interface Bm25Hit {
  id: string;
  score: number;
}

const K1 = 1.5;
const B = 0.75;

export class Bm25Index {
  private docs: { id: string; terms: Map<string, number>; length: number }[] = [];
  private df = new Map<string, number>();
  private avgLen = 0;

  constructor(docs: Bm25Doc[]) {
    for (const d of docs) {
      const tokens = tokenize(d.text);
      const terms = new Map<string, number>();
      for (const t of tokens) terms.set(t, (terms.get(t) ?? 0) + 1);
      for (const t of terms.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs.push({ id: d.id, terms, length: tokens.length });
    }
    const total = this.docs.reduce((s, d) => s + d.length, 0);
    this.avgLen = this.docs.length ? total / this.docs.length : 0;
  }

  private idf(term: string): number {
    const n = this.docs.length;
    const df = this.df.get(term) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  query(q: string, limit: number): Bm25Hit[] {
    const qterms = tokenize(q);
    const scored: Bm25Hit[] = [];
    for (const doc of this.docs) {
      let score = 0;
      for (const term of qterms) {
        const tf = doc.terms.get(term);
        if (!tf) continue;
        const idf = this.idf(term);
        const denom = tf + K1 * (1 - B + (B * doc.length) / this.avgLen);
        score += idf * ((tf * (K1 + 1)) / denom);
      }
      if (score > 0) scored.push({ id: doc.id, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }
}
