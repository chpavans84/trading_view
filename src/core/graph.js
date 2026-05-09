import neo4j from 'neo4j-driver';

let _driver = null;

export function isGraphConfigured() {
  return !!(process.env.NEO4J_URI && process.env.NEO4J_PASSWORD);
}

export async function getDriver() {
  if (_driver) return _driver;
  if (!isGraphConfigured())
    throw new Error('Neo4j not configured — set NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD in .env');
  _driver = neo4j.driver(
    process.env.NEO4J_URI,
    neo4j.auth.basic(process.env.NEO4J_USER || 'neo4j', process.env.NEO4J_PASSWORD)
  );
  await _driver.verifyConnectivity();
  return _driver;
}

export async function closeGraph() {
  if (_driver) { await _driver.close(); _driver = null; }
}

async function run(cypher, params = {}) {
  const driver  = await getDriver();
  const session = driver.session();
  try {
    const result = await session.run(cypher, params);
    return result.records;
  } finally {
    await session.close();
  }
}

export async function setupSchema() {
  const statements = [
    'CREATE CONSTRAINT company_ticker IF NOT EXISTS FOR (c:Company) REQUIRE c.ticker IS UNIQUE',
    'CREATE CONSTRAINT sector_name    IF NOT EXISTS FOR (s:Sector)  REQUIRE s.name   IS UNIQUE',
    'CREATE INDEX company_sector     IF NOT EXISTS FOR (c:Company) ON (c.sector)',
    'CREATE INDEX company_market_cap IF NOT EXISTS FOR (c:Company) ON (c.market_cap_usd)',
  ];
  for (const q of statements) {
    try { await run(q); } catch { /* already exists */ }
  }
  console.log('[graph] Schema ready');
}

export async function upsertCompany(data) {
  const { ticker, name, sector = null, sub_sector = null, exchange = null,
          country = null, market_cap_usd = null } = data;
  await run(`
    MERGE (c:Company {ticker: $ticker})
    SET c.name = $name, c.sector = $sector, c.sub_sector = $sub_sector,
        c.exchange = $exchange, c.country = $country,
        c.market_cap_usd = $market_cap_usd, c.last_updated = date()
  `, { ticker, name, sector, sub_sector, exchange, country, market_cap_usd });
}

const VALID_REL_TYPES = new Set([
  'SUPPLIES_TO', 'MANUFACTURES_FOR', 'CUSTOMER_OF',
  'OWNS_EQUITY_IN', 'LICENSES_TO', 'COMPETES_WITH',
  'MEMBER_OF', 'HELD_BY', 'OPERATES_IN', 'ACQUIRED',
]);

export async function upsertRelationship({ from, to, type, props = {} }) {
  if (!VALID_REL_TYPES.has(type)) throw new Error(`Invalid relationship type: ${type}`);
  const setParts = [...Object.keys(props).map(k => `r.${k} = $props.${k}`), 'r.last_updated = date()'];
  await run(`
    MATCH (a:Company {ticker: $from})
    MATCH (b:Company {ticker: $to})
    MERGE (a)-[r:${type}]->(b)
    SET ${setParts.join(', ')}
  `, { from, to, props });
}

export async function getContagionImpact(ticker, eventPct = -10, maxHops = 3) {
  const HOP_DECAY = [1.0, 0.55, 0.25];
  const records = await run(`
    MATCH path = (origin:Company {ticker: $ticker})-[*1..${maxHops}]->(impact:Company)
    WHERE impact.ticker <> $ticker
    WITH impact, length(path) AS hops, relationships(path) AS rels
    RETURN impact.ticker AS ticker, impact.name AS name, impact.sector AS sector, hops,
           [r IN rels | { type: type(r), weight: coalesce(r.market_share_pct, r.revenue_pct, r.ownership_pct, r.overlap_pct, 30) }] AS rel_chain
    ORDER BY hops ASC
  `, { ticker });

  return records.map(r => {
    const chain        = r.get('rel_chain');
    const hops         = r.get('hops').toNumber();
    const decay        = HOP_DECAY[hops - 1] ?? 0.1;
    const isCompetitor = chain.some(c => c.type === 'COMPETES_WITH');
    const chainWeight  = chain.reduce((acc, c) => acc * ((c.weight ?? 30) / 100), 1.0);
    const rawImpact    = +(eventPct * chainWeight * decay).toFixed(2);
    return {
      ticker: r.get('ticker'), name: r.get('name'), sector: r.get('sector'), hops,
      impact_pct:   isCompetitor ? -rawImpact : rawImpact,
      chain_weight: +(chainWeight * 100).toFixed(1),
      relationship: chain.map(c => c.type).join(' → '),
      type: isCompetitor ? 'sympathy_inverse' : 'contagion',
    };
  }).filter(r => Math.abs(r.impact_pct) > 0.5)
    .sort((a, b) => Math.abs(b.impact_pct) - Math.abs(a.impact_pct));
}

export async function getSympathyTrades(ticker) {
  const records = await run(`
    MATCH (origin:Company {ticker: $ticker})-[r:COMPETES_WITH|SUPPLIES_TO|MANUFACTURES_FOR]-(peer:Company)
    RETURN peer.ticker AS ticker, peer.name AS name, peer.sector AS sector,
           type(r) AS rel_type, coalesce(r.overlap_pct, r.market_share_pct, r.revenue_pct, 30) AS strength
    ORDER BY strength DESC
  `, { ticker });
  return records.map(r => ({ ticker: r.get('ticker'), name: r.get('name'), sector: r.get('sector'), rel_type: r.get('rel_type'), strength: r.get('strength') }));
}

export async function getSystemicRisk(ticker) {
  const records = await run(`
    MATCH (c:Company {ticker: $ticker})-[r]-()
    RETURN count(r) AS connections, collect(DISTINCT type(r)) AS rel_types
  `, { ticker });
  if (!records.length) return { ticker, connections: 0, risk_tier: 'unknown' };
  const conn = records[0].get('connections').toNumber();
  return { ticker, connections: conn, rel_types: records[0].get('rel_types'),
    risk_tier: conn >= 15 ? 'critical' : conn >= 8 ? 'high' : conn >= 4 ? 'medium' : 'low' };
}

export async function getGraphStats() {
  const records = await run(`
    MATCH (c:Company) WITH count(c) AS companies
    MATCH ()-[r]-() WITH companies, count(r)/2 AS relationships
    RETURN companies, relationships
  `);
  if (!records.length) return { companies: 0, relationships: 0 };
  return { companies: records[0].get('companies').toNumber(), relationships: records[0].get('relationships').toNumber() };
}
