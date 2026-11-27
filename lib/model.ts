// Token radar scoring model: one snapshot in, one ranked board out.
// Implied value = TVL base x growth tilt x maturity tilt, floor-normalised.
// Farm plans are generated per protocol from category and chain count.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    base_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

const BASE_MULTIPLE = 0.35;
const GROWTH_WEIGHT = 0.6;
const UNKNOWN_AGE_DAYS = 365;

export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('snapshot is not an object');
  if (!Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) throw new Error('snapshot lacks protocols/watchlist');
  return {
    as_of: raw.as_of,
    source: raw.source,
    floor_usd: raw.floor_usd,
    watchlist: raw.watchlist,
    protocols: raw.protocols.map((p: any) => ({
      slug: String(p.slug), name: String(p.name),
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c: any) => typeof c === 'string') : [],
      tvl_usd: Number(p.tvl_usd) || 0,
      change_7d: typeof p.change_7d === 'number' ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    })),
  };
}

export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

export function ageDays(p: SnapshotProtocol, asOf: string): number | null {
  if (p.listed_at === null) return null;
  const t = Date.parse(`${p.listed_at}T00:00:00Z`);
  const a = Date.parse(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(t) || !Number.isFinite(a)) return null;
  return Math.max(0, Math.round((a - t) / 86_400_000));
}

export function impliedValue(p: SnapshotProtocol, age: number | null): { value: number; growth: number; gm: number; mm: number } {
  const base = p.tvl_usd * BASE_MULTIPLE;
  const growth = Math.min(120, Math.max(-60, p.change_7d ?? 0));
  const gm = 1 + (growth / 100) * GROWTH_WEIGHT;
  const days = age ?? UNKNOWN_AGE_DAYS;
  const mm = 0.55 + (Math.min(days, 1095) / 1095) * 0.45;
  return { value: Math.max(1, Math.round(base * gm * mm)), growth, gm, mm };
}

const CATEGORY_ACTION: [RegExp, string][] = [
  [/lend|borrow|credit/i, 'Supply capital to the protocol\'s largest market and optionally loop a conservative borrow'],
  [/dex|exchange|swap|liquidity/i, 'Provide liquidity to the deepest pair and route weekly volume through the pool'],
  [/yield|farm|vault|staking/i, 'Deposit into the flagship vault and keep the position compounding'],
  [/deriv|perp|option|future/i, 'Open a small hedged position and hold open interest through the epoch'],
  [/bridge|cross.?chain/i, 'Bridge funds both directions weekly to build counted transfer volume'],
  [/rwa|real.?world/i, 'Complete onboarding early and hold a qualifying position through distribution'],
  [/gaming|nft|social/i, 'Mint or trade one qualifying item weekly and keep the wallet active'],
];

function actionFor(p: SnapshotProtocol): string {
  const cat = p.category ?? '';
  for (const [re, action] of CATEGORY_ACTION) if (re.test(cat)) return action;
  return 'Make qualifying deposits and interactions on the protocol\'s main product each week';
}

export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const capital = p.tvl_usd >= 500_000_000 ? '$2,000-$5,000' : p.tvl_usd >= 100_000_000 ? '$500-$2,000' : '$100-$500';
  const chain = p.chains[0] ?? 'its home chain';
  const hold = age !== null && age < 180 ? '30' : '60';
  return [
    `Set up a dedicated wallet on ${chain} holding only the funds you intend to farm with; keep the seed phrase offline and never reuse a doxxed address.`,
    `${actionFor(p)} on ${p.name}. A qualifying position is typically ${capital} given the protocol's $${Math.round(p.tvl_usd / 1e6)}M TVL.`,
    `Repeat at least one counted action per week: deposits, swaps, borrows or votes all register on most points systems.`,
    `Hold the position open for at least ${hold} days so activity spans multiple snapshot windows rather than a single check-in.`,
    `Track the protocol's official points or leaderboard page weekly and claim only through links published by the protocol itself.`,
    `Log every transaction hash and date in a farm journal so the position can be replicated or unwound cleanly at TGE.`,
  ];
}

export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const seen = new Set(snapshot.watchlist);
  const wanted = new Set(snapshot.watchlist);
  const eligible = snapshot.protocols.filter((p) => isPreToken(p) && wanted.has(p.slug));
  const extras = snapshot.protocols
    .filter((p) => isPreToken(p) && !wanted.has(p.slug))
    .sort((a, b) => b.tvl_usd - a.tvl_usd)
    .slice(0, 160);
  const rows = [...eligible, ...extras.filter((e) => !seen.has(e.slug))].map((p) => {
    const age = ageDays(p, snapshot.as_of);
    const { value, growth, gm, mm } = impliedValue(p, age);
    return {
      rank: 0,
      slug: p.slug, name: p.name, category: p.category, chains: p.chains,
      tvl_usd: p.tvl_usd, change_7d: p.change_7d, mcap_usd: p.mcap_usd,
      listed_at: p.listed_at, gecko_id: p.gecko_id, symbol: p.symbol,
      token_status: 'pre-token' as const,
      age_days: age,
      implied_value_usd: value,
      model: {
        base_multiple: BASE_MULTIPLE,
        growth_pct: growth,
        growth_multiplier: Math.round(gm * 1000) / 1000,
        maturity_multiplier: Math.round(mm * 1000) / 1000,
        age_days: age,
      },
      farm_steps: farmSteps(p, age),
    };
  });
  rows.sort((a, b) => b.implied_value_usd - a.implied_value_usd || a.slug.localeCompare(b.slug));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}
