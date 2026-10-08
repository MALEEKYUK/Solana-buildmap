const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
// Set SOLANA_RPC_URL in Railway Variables to use your own (faster) RPC provider.
const RPCS = (process.env.SOLANA_RPC_URL || '').split(',').map(x => x.trim()).filter(Boolean).concat(['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com']);
let lastGood = 0;
const ROOT = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon' };

async function rpc(method, params = []) {
  let lastErr;
  for (let k = 0; k < RPCS.length; k++) {
    const i = (lastGood + k) % RPCS.length;
    try {
      const r = await fetch(RPCS[i], {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(8000)
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      lastGood = i;
      return j.result;
    } catch (e) {
      lastErr = new Error(new URL(RPCS[i]).host + ': ' + e.message);
      console.error(method, lastErr.message);
    }
  }
  throw lastErr;
}

let statsCache = { t: 0, v: null };
async function getStats() {
  if (statsCache.v && Date.now() - statsCache.t < 3000) return statsCache.v;
  const [epoch, perf, fees] = await Promise.all([rpc('getEpochInfo'), rpc('getRecentPerformanceSamples', [1]).catch(() => null), rpc('getRecentPrioritizationFees').catch(() => null)]);
  let fee = null;
  if (fees && fees.length) { const a = fees.map(f => f.prioritizationFee).sort((x, y) => x - y); fee = a[Math.floor(a.length / 2)]; }
  const p = perf && perf[0];
  const tps = p && p.samplePeriodSecs ? p.numTransactions / p.samplePeriodSecs : null;
  const v = { slot: epoch.absoluteSlot, blockHeight: epoch.blockHeight, epochPct: (epoch.slotIndex / epoch.slotsInEpoch) * 100, tps, fee };
  statsCache = { t: Date.now(), v };
  return v;
}

const balCache = new Map();
async function getBalance(addr) {
  const c = balCache.get(addr);
  if (c && Date.now() - c.t < 5000) return c.v;
  const res = await rpc('getBalance', [addr]);
  const v = { sol: res.value / 1e9 };
  if (balCache.size > 500) balCache.clear();
  balCache.set(addr, { t: Date.now(), v });
  return v;
}

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
async function getWallet(addr) {
  const c = balCache.get('w' + addr);
  if (c && Date.now() - c.t < 5000) return c.v;
  const [bal, sigs, toks] = await Promise.allSettled([
    rpc('getBalance', [addr]),
    rpc('getSignaturesForAddress', [addr, { limit: 5 }]),
    rpc('getTokenAccountsByOwner', [addr, { programId: TOKEN_PROGRAM }, { encoding: 'jsonParsed' }])
  ]);
  if (bal.status !== 'fulfilled') throw new Error('balance failed');
  const v = {
    sol: bal.value.value / 1e9,
    txs: (sigs.status === 'fulfilled' ? sigs.value : []).map(x => ({ sig: x.signature, time: x.blockTime, ok: !x.err })),
    tokens: (toks.status === 'fulfilled' ? toks.value.value : []).map(a => a.account.data.parsed.info).filter(i => i.tokenAmount.uiAmount > 0).map(i => ({ mint: i.mint, amount: i.tokenAmount.uiAmount })).slice(0, 25)
  };
  if (balCache.size > 500) balCache.clear();
  balCache.set('w' + addr, { t: Date.now(), v });
  return v;
}

const REPOS = ['solana-foundation/pay', 'solana-foundation/pay-kit', 'anza-xyz/wallet-adapter', 'solana-foundation/templates', 'solana-foundation/create-solana-dapp', 'solana-foundation/surfpool', 'solana-foundation/solana-developer-platform', 'solana-foundation/explorer', 'solana-foundation/solana-data-aggregator', 'solana-foundation/solana-go', 'firedancer-io/firedancer'];
let repoCache = { t: 0, v: null };
async function getRepos() {
  if (repoCache.v && Date.now() - repoCache.t < 3600000) return repoCache.v;
  const out = {};
  const headers = { 'User-Agent': 'solana-buildmap', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = 'Bearer ' + process.env.GITHUB_TOKEN;
  await Promise.all(REPOS.map(async n => {
    try {
      const r = await fetch('https://api.github.com/repos/' + n, { headers, signal: AbortSignal.timeout(8000) });
      if (r.ok) { const j = await r.json(); out[n] = { stars: j.stargazers_count, pushed: j.pushed_at }; }
    } catch (e) {}
  }));
  if (Object.keys(out).length) repoCache = { t: Date.now(), v: out };
  return out;
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true, rpcs: RPCS.map(u => new URL(u).host), lastGood: new URL(RPCS[lastGood]).host });
    if (url.pathname === '/api/stats') return sendJson(res, 200, await getStats());
    if (url.pathname === '/api/repos') return sendJson(res, 200, await getRepos());
    if (url.pathname === '/api/wallet') {
      const addr = url.searchParams.get('address') || '';
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) return sendJson(res, 400, { error: 'Invalid Solana address' });
      return sendJson(res, 200, await getWallet(addr));
    }
    if (url.pathname === '/api/balance') {
      const addr = url.searchParams.get('address') || '';
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) return sendJson(res, 400, { error: 'Invalid Solana address' });
      return sendJson(res, 200, await getBalance(addr));
    }
  } catch (e) {
    console.error(e.message);
    return sendJson(res, 502, { error: 'Solana network request failed', detail: e.message });
  }
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    if (path.basename(file) === 'index.html') {
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      return res.end(data.toString().split('__ORIGIN__').join(proto + '://' + host));
    }
    res.end(data);
  });
}).listen(PORT, '0.0.0.0', () => console.log('Listening on ' + PORT));
