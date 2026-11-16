// Mẫu hàm serverless Vercel: GET /api/web-search?q=<từ khóa>
// Trả danh sách trang web thật (tiêu đề + link + đoạn trích) kiểu Google,
// phục vụ trang kết quả tự vẽ của app Cảng Lướt. Không key, không tài khoản.
// Nguồn theo thứ tự: DuckDuckGo HTML (POST) -> Bing HTML -> DuckDuckGo Lite.
// Đã kiểm chứng logic parse bằng Node trên trang HTML thật ngày 16/11/2026
// (DDG POST 9/9/10 kết quả, Bing 10/10, Lite 9).
// CÁCH DÙNG: copy file này thành api/web-search.js ở gốc repo tham-tu-hem-cang.
// Vercel tự nhận hàm serverless, không cần package.json, không cần biến môi trường.
// Chi tiết đầy đủ xem report.md cùng thư mục.
const CACHE = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 phút

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function strip(s) {
  return (s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(+c))
    .replace(/\s+/g, ' ').trim();
}

function resolveUrl(href) {
  href = (href || '').replace(/&amp;/g, '&');
  const m = href.match(/uddg=([^&"']+)/);
  if (m) { try { return decodeURIComponent(m[1]); } catch (e) {} }
  if (href.startsWith('//')) return 'https:' + href;
  return href;
}

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

function clean(r) {
  return {
    title: (r.title || '').slice(0, 160),
    url: r.url || '',
    snippet: (r.snippet || '').slice(0, 220),
    domain: domainOf(r.url || ''),
  };
}

async function fetchText(url, opts, timeoutMs = 7000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: c.signal });
    const text = await res.text();
    return { status: res.status, text };
  } finally { clearTimeout(t); }
}

// ---- Nguồn 1: DuckDuckGo HTML qua POST (bắt buộc POST; GET bị trang anomaly) ----
function parseDDG(html) {
  const links = [...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs)];
  const snips = [...html.matchAll(/class="result__snippet"[^>]*>(.*?)<\/a>/gs)];
  return links
    .map((m, i) => ({ title: strip(m[2]), url: resolveUrl(m[1]), snippet: strip(snips[i] ? snips[i][1] : '') }))
    .filter((r) => r.title && r.url.startsWith('http'));
}

async function searchDDG(q) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 600));
    const { status, text } = await fetchText('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA,
        'Accept-Language': 'vi-VN,vi;q=0.9',
      },
      body: 'q=' + encodeURIComponent(q),
    });
    if (status !== 200) throw new Error('DDG HTTP ' + status);
    if (text.includes('anomaly')) throw new Error('DDG anomaly (bot check)');
    const results = parseDDG(text);
    if (results.length) return results;
    // 0 kết quả: có thể là trang anomaly dạng khác -> thử lại 1 lần rồi buông
  }
  throw new Error('DDG: 0 kết quả sau 2 lần thử');
}

// ---- Nguồn 2: Bing HTML (GET). Link là redirect, URL thật ở tham số u (base64) ----
function b64url(u) {
  if (!u || !u.startsWith('a1')) return '';
  try { return Buffer.from(u.slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch (e) { return ''; }
}

function parseBing(html) {
  const blocks = [...html.matchAll(/<li class="b_algo".*?<\/li>/gs)].map((m) => m[0]);
  const out = [];
  for (const b of blocks) {
    const m = b.match(/<h2><a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a><\/h2>/s);
    if (!m) continue;
    let url = '';
    try {
      const u = new URL(m[1].replace(/&amp;/g, '&'), 'https://www.bing.com').searchParams.get('u');
      url = b64url(u || '');
    } catch (e) {}
    const sn = b.match(/<div class="b_caption"[^>]*>(.*?)<\/div>/s);
    out.push({ title: strip(m[2]), url, snippet: strip(sn ? sn[1] : '') });
  }
  return out.filter((r) => r.title && r.url.startsWith('http'));
}

async function searchBing(q) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 600));
    const { status, text } = await fetchText(
      'https://www.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=vi-VN&cc=VN',
      { headers: { 'User-Agent': UA, 'Accept-Language': 'vi-VN,vi;q=0.9' } }
    );
    if (status !== 200) throw new Error('Bing HTTP ' + status);
    const results = parseBing(text);
    if (results.length) return results;
  }
  throw new Error('Bing: 0 kết quả sau 2 lần thử');
}

// ---- Nguồn 3: DuckDuckGo Lite (GET) ----
function parseLite(html) {
  const tags = [...html.matchAll(/<a[^>]*class='result-link'[^>]*>(.*?)<\/a>/gs)];
  const snips = [...html.matchAll(/class='result-snippet'[^>]*>(.*?)<\/td>/gs)];
  return tags
    .map((m, i) => {
      const hm = m[0].match(/href="([^"]+)"/);
      return { title: strip(m[1]), url: resolveUrl(hm ? hm[1] : ''), snippet: strip(snips[i] ? snips[i][1] : '') };
    })
    .filter((r) => r.title && r.url.startsWith('http'));
}

async function searchLite(q) {
  const { status, text } = await fetchText(
    'https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(q),
    { headers: { 'User-Agent': UA, 'Accept-Language': 'vi-VN,vi;q=0.9' } }
  );
  if (status !== 200) throw new Error('Lite HTTP ' + status);
  const results = parseLite(text);
  if (!results.length) throw new Error('Lite: 0 kết quả');
  return results;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  const q = String((req.query && req.query.q) || '').trim();
  if (!q) {
    res.status(400).json({ ok: false, error: 'Thiếu từ khóa tìm kiếm.' });
    return;
  }
  const key = q.toLowerCase();
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL) {
    res.status(200).json({ ok: true, source: hit.source, cached: true, results: hit.results });
    return;
  }
  const attempts = [
    ['duckduckgo', searchDDG],
    ['bing', searchBing],
    ['duckduckgo-lite', searchLite],
  ];
  let lastErr = '';
  for (const [name, fn] of attempts) {
    try {
      const results = (await fn(q)).slice(0, 10).map(clean);
      if (results.length) {
        CACHE.set(key, { t: Date.now(), source: name, results });
        res.status(200).json({ ok: true, source: name, results });
        return;
      }
      lastErr = name + ': không có kết quả';
    } catch (e) {
      lastErr = name + ': ' + (e && e.message ? e.message : String(e));
    }
  }
  res.status(502).json({ ok: false, error: 'Không tìm được kết quả web. (' + lastErr + ')' });
};

// Cho phép nâng timeout hàm trên gói Hobby (mặc định 10s, tối đa 60s):
module.exports.config = { maxDuration: 30 };
