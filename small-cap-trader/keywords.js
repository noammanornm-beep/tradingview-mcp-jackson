/**
 * keywords.js
 * Keyword intelligence system for small cap catalyst detection.
 *
 * Flow:
 *   1. Stock gets news / guidance / earnings text
 *   2. matchKeywords(text) → returns matched keywords + score
 *   3. We save the match alongside the stock scan
 *   4. After price data comes in → recordOutcome() updates hit rate stats
 *   5. Over time: keywords.json becomes a statistical edge database
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const KW_FILE    = path.join(__dirname, 'data', 'keywords.json');

// ── Default keyword list ────────────────────────────────────────────────────
// Each keyword has:
//   phrase      - what to search for (case insensitive)
//   category    - grouping
//   sentiment   - 'bullish' | 'bearish' | 'neutral'
//   base_score  - starting weight (1-10), higher = stronger expected move
//   notes       - why this matters for small caps

const DEFAULT_KEYWORDS = [

  // ── FDA / Biotech ── (highest movers in small caps)
  { phrase: 'fda approval',          category: 'fda',      sentiment: 'bullish', base_score: 10, notes: 'Drug/device approval — massive catalyst' },
  { phrase: 'fda approved',          category: 'fda',      sentiment: 'bullish', base_score: 10, notes: 'Same as above, past tense' },
  { phrase: 'breakthrough therapy',  category: 'fda',      sentiment: 'bullish', base_score: 9,  notes: 'FDA fast track designation' },
  { phrase: 'fast track',            category: 'fda',      sentiment: 'bullish', base_score: 8,  notes: 'FDA fast track — accelerated review' },
  { phrase: 'orphan drug',           category: 'fda',      sentiment: 'bullish', base_score: 7,  notes: 'Rare disease designation — tax benefits + exclusivity' },
  { phrase: 'pdufa',                 category: 'fda',      sentiment: 'bullish', base_score: 9,  notes: 'FDA decision date — binary event' },
  { phrase: 'nda submission',        category: 'fda',      sentiment: 'bullish', base_score: 7,  notes: 'New Drug Application filed' },
  { phrase: 'anda',                  category: 'fda',      sentiment: 'bullish', base_score: 5,  notes: 'Generic drug application' },
  { phrase: 'phase 3',               category: 'clinical', sentiment: 'bullish', base_score: 8,  notes: 'Final clinical trial phase — high binary risk/reward' },
  { phrase: 'phase 2',               category: 'clinical', sentiment: 'bullish', base_score: 6,  notes: 'Mid-stage trial results' },
  { phrase: 'clinical trial',        category: 'clinical', sentiment: 'neutral', base_score: 5,  notes: 'Generic trial mention' },
  { phrase: 'trial results',         category: 'clinical', sentiment: 'bullish', base_score: 7,  notes: 'Results from any trial stage' },
  { phrase: 'statistically significant', category:'clinical', sentiment:'bullish', base_score:8, notes:'Trial success language' },
  { phrase: 'complete response letter', category:'fda',    sentiment: 'bearish', base_score: 9,  notes: 'FDA rejection — major drop catalyst' },
  { phrase: 'fda rejection',         category: 'fda',      sentiment: 'bearish', base_score: 10, notes: 'FDA rejected application' },

  // ── Earnings / Guidance ──
  { phrase: 'beat expectations',     category: 'earnings', sentiment: 'bullish', base_score: 7,  notes: 'EPS/revenue beat' },
  { phrase: 'eps beat',              category: 'earnings', sentiment: 'bullish', base_score: 7,  notes: 'Earnings per share beat' },
  { phrase: 'raised guidance',       category: 'guidance', sentiment: 'bullish', base_score: 8,  notes: 'Company raised forward guidance — strong signal' },
  { phrase: 'raises guidance',       category: 'guidance', sentiment: 'bullish', base_score: 8,  notes: 'Same, present tense' },
  { phrase: 'raised outlook',        category: 'guidance', sentiment: 'bullish', base_score: 8,  notes: 'Outlook raised' },
  { phrase: 'lowered guidance',      category: 'guidance', sentiment: 'bearish', base_score: 8,  notes: 'Guidance cut — sell signal' },
  { phrase: 'lowers guidance',       category: 'guidance', sentiment: 'bearish', base_score: 8,  notes: 'Same, present tense' },
  { phrase: 'record revenue',        category: 'earnings', sentiment: 'bullish', base_score: 7,  notes: 'All-time high revenue' },
  { phrase: 'record earnings',       category: 'earnings', sentiment: 'bullish', base_score: 7,  notes: 'All-time high earnings' },
  { phrase: 'profitable',            category: 'earnings', sentiment: 'bullish', base_score: 6,  notes: 'Profitability milestone — big for small caps' },
  { phrase: 'first profitable',      category: 'earnings', sentiment: 'bullish', base_score: 8,  notes: 'First time profitable — major milestone' },
  { phrase: 'revenue growth',        category: 'earnings', sentiment: 'bullish', base_score: 5,  notes: 'General growth mention' },
  { phrase: 'missed expectations',   category: 'earnings', sentiment: 'bearish', base_score: 6,  notes: 'EPS/revenue miss' },
  { phrase: 'going concern',         category: 'earnings', sentiment: 'bearish', base_score: 9,  notes: 'Auditor doubt — major red flag' },

  // ── M&A / Deals ──
  { phrase: 'merger',                category: 'ma',       sentiment: 'bullish', base_score: 9,  notes: 'Merger announcement' },
  { phrase: 'acquisition',           category: 'ma',       sentiment: 'bullish', base_score: 9,  notes: 'Takeover / being acquired' },
  { phrase: 'buyout',                category: 'ma',       sentiment: 'bullish', base_score: 9,  notes: 'Buyout offer' },
  { phrase: 'tender offer',          category: 'ma',       sentiment: 'bullish', base_score: 9,  notes: 'Formal buyout at premium' },
  { phrase: 'strategic alternative', category: 'ma',       sentiment: 'bullish', base_score: 7,  notes: 'Code for potential sale of company' },
  { phrase: 'letter of intent',      category: 'ma',       sentiment: 'bullish', base_score: 7,  notes: 'LOI for deal — early stage' },
  { phrase: 'definitive agreement',  category: 'ma',       sentiment: 'bullish', base_score: 8,  notes: 'Deal signed' },

  // ── Contracts / Revenue ──
  { phrase: 'government contract',   category: 'contract', sentiment: 'bullish', base_score: 8,  notes: 'Gov contracts = reliable revenue for small caps' },
  { phrase: 'contract awarded',      category: 'contract', sentiment: 'bullish', base_score: 7,  notes: 'Won a contract' },
  { phrase: 'multi-year contract',   category: 'contract', sentiment: 'bullish', base_score: 7,  notes: 'Long-term revenue visibility' },
  { phrase: 'purchase order',        category: 'contract', sentiment: 'bullish', base_score: 6,  notes: 'Customer order received' },
  { phrase: 'partnership',           category: 'contract', sentiment: 'bullish', base_score: 5,  notes: 'Business partnership — varies widely' },
  { phrase: 'licensing agreement',   category: 'contract', sentiment: 'bullish', base_score: 6,  notes: 'Licensing deal' },

  // ── Dilution / Offerings ── (bearish for small caps)
  { phrase: 'public offering',       category: 'dilution', sentiment: 'bearish', base_score: 8,  notes: 'Share offering — dilutive, price drops' },
  { phrase: 'private placement',     category: 'dilution', sentiment: 'bearish', base_score: 7,  notes: 'PIPE deal — often discounted shares' },
  { phrase: 'atm offering',          category: 'dilution', sentiment: 'bearish', base_score: 7,  notes: 'At-the-market offering — slow dilution' },
  { phrase: 'shelf registration',    category: 'dilution', sentiment: 'bearish', base_score: 6,  notes: 'Plans to sell shares — overhang' },
  { phrase: 'warrant',               category: 'dilution', sentiment: 'bearish', base_score: 5,  notes: 'Warrants outstanding — dilution risk' },
  { phrase: 'convertible note',      category: 'dilution', sentiment: 'bearish', base_score: 7,  notes: 'Debt that converts to shares' },
  { phrase: 'registered direct',     category: 'dilution', sentiment: 'bearish', base_score: 7,  notes: 'Direct offering to institutions' },

  // ── Short Squeeze ──
  { phrase: 'short squeeze',         category: 'squeeze',  sentiment: 'bullish', base_score: 8,  notes: 'Short squeeze underway or potential' },
  { phrase: 'heavily shorted',       category: 'squeeze',  sentiment: 'bullish', base_score: 6,  notes: 'High short interest = squeeze fuel' },
  { phrase: 'days to cover',         category: 'squeeze',  sentiment: 'bullish', base_score: 6,  notes: 'High days-to-cover = squeeze risk' },
  { phrase: 'short interest',        category: 'squeeze',  sentiment: 'neutral', base_score: 4,  notes: 'Short interest mentioned' },

  // ── Splits ──
  { phrase: 'reverse split',         category: 'split',    sentiment: 'bearish', base_score: 8,  notes: 'Reverse split = desperation / compliance issue' },
  { phrase: 'reverse stock split',   category: 'split',    sentiment: 'bearish', base_score: 8,  notes: 'Same, full phrase' },
  { phrase: 'forward split',         category: 'split',    sentiment: 'bullish', base_score: 6,  notes: 'Forward split = strength signal' },
  { phrase: 'stock split',           category: 'split',    sentiment: 'bullish', base_score: 6,  notes: 'Generic split — context matters' },

  // ── Compliance / Risk ──
  { phrase: 'nasdaq compliance',     category: 'risk',     sentiment: 'bearish', base_score: 7,  notes: 'Non-compliance notice — possible delisting' },
  { phrase: 'delisting',             category: 'risk',     sentiment: 'bearish', base_score: 9,  notes: 'Delisting threat or notice' },
  { phrase: 'minimum bid price',     category: 'risk',     sentiment: 'bearish', base_score: 7,  notes: 'Below $1 compliance issue' },
  { phrase: 'bankruptcy',            category: 'risk',     sentiment: 'bearish', base_score: 10, notes: 'Bankruptcy filing' },
  { phrase: 'chapter 11',            category: 'risk',     sentiment: 'bearish', base_score: 10, notes: 'Bankruptcy' },
  { phrase: 'sec investigation',     category: 'risk',     sentiment: 'bearish', base_score: 9,  notes: 'SEC probing the company' },
  { phrase: 'class action',          category: 'risk',     sentiment: 'bearish', base_score: 7,  notes: 'Lawsuit against the company' },

  // ── Tech / AI / Crypto (hot sectors) ──
  { phrase: 'artificial intelligence', category:'tech',    sentiment: 'bullish', base_score: 6,  notes: 'AI mention — currently hot theme' },
  { phrase: 'machine learning',      category: 'tech',     sentiment: 'bullish', base_score: 5,  notes: 'ML mention' },
  { phrase: 'blockchain',            category: 'tech',     sentiment: 'bullish', base_score: 5,  notes: 'Crypto/blockchain theme' },
  { phrase: 'bitcoin',               category: 'tech',     sentiment: 'bullish', base_score: 6,  notes: 'BTC exposure' },
  { phrase: 'quantum',               category: 'tech',     sentiment: 'bullish', base_score: 6,  notes: 'Quantum computing theme' },

  // ── Insider / Momentum ──
  { phrase: 'insider buying',        category: 'insider',  sentiment: 'bullish', base_score: 7,  notes: 'Management buying shares' },
  { phrase: 'buyback',               category: 'insider',  sentiment: 'bullish', base_score: 6,  notes: 'Share repurchase program' },
  { phrase: '52-week high',          category: 'momentum', sentiment: 'bullish', base_score: 6,  notes: 'Breakout to new highs' },
  { phrase: 'all-time high',         category: 'momentum', sentiment: 'bullish', base_score: 7,  notes: 'ATH breakout' },
];

// ── Load / Save keyword database ────────────────────────────────────────────
export function loadKeywords() {
  const dir = path.dirname(KW_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (!fs.existsSync(KW_FILE)) {
    // First run — seed with defaults
    const db = DEFAULT_KEYWORDS.map(kw => ({
      ...kw,
      id:           kw.phrase.replace(/\s+/g, '_').toLowerCase(),
      occurrences:  0,   // times this keyword was matched
      move_count:   0,   // times price moved ≥5% after match
      total_move:   0,   // sum of absolute % moves after match
      hit_rate:     null, // move_count / occurrences
      avg_move:     null, // total_move / move_count
      created_at:   new Date().toISOString(),
    }));
    fs.writeFileSync(KW_FILE, JSON.stringify(db, null, 2));
    return db;
  }
  return JSON.parse(fs.readFileSync(KW_FILE, 'utf8'));
}

function saveKeywords(db) {
  fs.writeFileSync(KW_FILE, JSON.stringify(db, null, 2));
}

// ── Match keywords against text ─────────────────────────────────────────────
/**
 * @param {string} text - news headline, guidance text, etc.
 * @returns {{ matches: array, score: number, signals: {bullish, bearish} }}
 */
export function matchKeywords(text) {
  if (!text) return { matches: [], score: 0, signals: { bullish: 0, bearish: 0 } };
  const lower = text.toLowerCase();
  const db    = loadKeywords();
  const matches = [];

  for (const kw of db) {
    if (lower.includes(kw.phrase)) {
      matches.push({
        phrase:     kw.phrase,
        category:   kw.category,
        sentiment:  kw.sentiment,
        base_score: kw.base_score,
        hit_rate:   kw.hit_rate,
        avg_move:   kw.avg_move,
        // Effective score: base adjusted by historical hit rate (if we have data)
        effective_score: kw.hit_rate != null
          ? +(kw.base_score * kw.hit_rate).toFixed(2)
          : kw.base_score,
      });
    }
  }

  const bullish_score = matches.filter(m=>m.sentiment==='bullish').reduce((s,m)=>s+m.effective_score, 0);
  const bearish_score = matches.filter(m=>m.sentiment==='bearish').reduce((s,m)=>s+m.effective_score, 0);
  const net_score     = +(bullish_score - bearish_score).toFixed(2);

  return {
    matches,
    score:   net_score,
    signals: { bullish: +bullish_score.toFixed(2), bearish: +bearish_score.toFixed(2) },
    summary: matches.map(m => m.phrase).join(' · ') || null,
  };
}

// ── Record outcome to improve hit rates ─────────────────────────────────────
/**
 * After we know how price moved, call this to update keyword stats.
 * @param {string[]} phrases   - keyword phrases that were matched
 * @param {number}   move_pct  - actual price move % (signed)
 */
export function recordOutcome(phrases, move_pct) {
  if (!phrases?.length || move_pct == null) return;
  const db   = loadKeywords();
  const moved = Math.abs(move_pct) >= 5; // "significant move" threshold

  for (const phrase of phrases) {
    const kw = db.find(k => k.phrase === phrase);
    if (!kw) continue;
    kw.occurrences++;
    if (moved) {
      kw.move_count++;
      kw.total_move += Math.abs(move_pct);
    }
    kw.hit_rate = kw.occurrences > 0 ? +(kw.move_count / kw.occurrences).toFixed(3) : null;
    kw.avg_move = kw.move_count  > 0 ? +(kw.total_move  / kw.move_count).toFixed(2)  : null;
  }
  saveKeywords(db);
}

// ── Add / update / remove keywords ──────────────────────────────────────────
export function addKeyword(phrase, category, sentiment, base_score, notes = '') {
  const db = loadKeywords();
  const id = phrase.replace(/\s+/g, '_').toLowerCase();
  if (db.find(k => k.phrase === phrase)) throw new Error(`Keyword "${phrase}" already exists`);
  db.push({ id, phrase, category, sentiment, base_score, notes, occurrences:0, move_count:0, total_move:0, hit_rate:null, avg_move:null, created_at: new Date().toISOString() });
  saveKeywords(db);
  return db;
}

export function removeKeyword(phrase) {
  let db = loadKeywords();
  const before = db.length;
  db = db.filter(k => k.phrase !== phrase);
  if (db.length === before) throw new Error(`Keyword "${phrase}" not found`);
  saveKeywords(db);
  return db;
}

export function updateKeyword(phrase, updates) {
  const db = loadKeywords();
  const kw = db.find(k => k.phrase === phrase);
  if (!kw) throw new Error(`Keyword "${phrase}" not found`);
  Object.assign(kw, updates);
  saveKeywords(db);
  return db;
}

export function getKeywordStats() {
  const db = loadKeywords();
  return {
    total:      db.length,
    bullish:    db.filter(k=>k.sentiment==='bullish').length,
    bearish:    db.filter(k=>k.sentiment==='bearish').length,
    neutral:    db.filter(k=>k.sentiment==='neutral').length,
    categories: [...new Set(db.map(k=>k.category))],
    top_performers: [...db]
      .filter(k => k.hit_rate != null && k.occurrences >= 3)
      .sort((a,b) => b.hit_rate - a.hit_rate)
      .slice(0, 10),
    keywords: db,
  };
}
