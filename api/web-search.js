// Hàm serverless Vercel: GET /api/web-search?q=<từ khóa>
// Trả danh sách trang web thật (tiêu đề + link + đoạn trích) kiểu Google,
// phục vụ trang kết quả tự vẽ của app Cảng Lướt.
// Nguồn theo thứ tự: Tavily có key -> Tavily keyless -> Serper -> Exa.
// Gói miễn phí, KHÔNG cần thẻ: Tavily Researcher 1.000 lượt/tháng,
// Serper 2.500 lượt một lần, Exa $10/tháng. Key giữ trong biến môi trường
// Vercel (TAVILY_API_KEY, SERPER_API_KEY, EXA_API_KEY), không ghi vào code.
// search_depth luôn "basic" (1 credit/lượt); không bật advanced,
// include_answer hay include_raw_content (tốn thêm credit). Cache 5 phút.
// Phân biệt "hết lượt miễn phí" (quota_exhausted: true) với "lỗi mạng".
// Chi tiết đầy đủ xem research_notes/tim-kiem-web-that-khong-can-the-20261116/report.md
// Lịch sử: trước đây dùng DuckDuckGo/Bing HTML, chết từ IP Vercel (kết quả
// sai/502) nên bỏ hẳn từ bản này. Brave cũng bị loại vì bắt nhập thẻ.
const CACHE = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 phút

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

function toResults(list) {
  return (list || [])
    .map((r) => clean(r))
    .filter((r) => r.title && r.url.startsWith('http'));
}

function quotaError(source, status, detail) {
  const e = new Error(source + ' hết lượt miễn phí (' + status + ')' + (detail ? ': ' + detail : ''));
  e.quota = true;
  return e;
}

async function fetchJson(url, opts, timeoutMs) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: c.signal });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    return { status: res.status, data };
  } finally { clearTimeout(t); }
}

// ---- Nguồn 1+2: Tavily (có key hoặc keyless) ----
// POST https://api.tavily.com/search
// Header có key:  Authorization: Bearer <TAVILY_API_KEY>
// Header keyless: X-Tavily-Access-Mode: keyless (không gửi Authorization)
async function searchTavily(q, apiKey) {
  const label = apiKey ? 'tavily' : 'tavily-keyless';
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
  else headers['X-Tavily-Access-Mode'] = 'keyless';
  let status, data;
  try {
    ({ status, data } = await fetchJson('https://api.tavily.com/search', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: q, search_depth: 'basic', max_results: 10,
        include_answer: false, include_raw_content: false,
      }),
    }, 8000));
  } catch (e) {
    throw new Error(label + ' lỗi mạng/timeout: ' + (e && e.message ? e.message : String(e)));
  }
  if (status === 402) throw quotaError(label, 402);
  if (status === 429) throw quotaError(label, 429, 'daily_cap_reached/ip_rate_limit_exceeded');
  if (status !== 200 || !data) throw new Error(label + ' HTTP ' + status);
  const results = toResults((data.results || []).map((r) => ({
    title: r.title, url: r.url, snippet: r.content || '',
  })));
  if (!results.length) throw new Error(label + ': 0 kết quả');
  return results;
}

// ---- Nguồn 3: Serper (kết quả Google thật) ----
// POST https://google.serper.dev/search, header X-API-KEY
async function searchSerper(q, apiKey) {
  let status, data;
  try {
    ({ status, data } = await fetchJson('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
      body: JSON.stringify({ q, num: 10, gl: 'vn', hl: 'vi' }),
    }, 6000));
  } catch (e) {
    throw new Error('serper lỗi mạng/timeout: ' + (e && e.message ? e.message : String(e)));
  }
  if (status === 402) throw quotaError('serper', 402);
  if (status !== 200 || !data) throw new Error('serper HTTP ' + status);
  const results = toResults((data.organic || []).map((r) => ({
    title: r.title, url: r.link, snippet: r.snippet || '',
  })));
  if (!results.length) throw new Error('serper: 0 kết quả');
  return results;
}

// ---- Nguồn 4: Exa (tìm kiếm ngữ nghĩa) ----
// POST https://api.exa.ai/search, header x-api-key
async function searchExa(q, apiKey) {
  let status, data;
  try {
    ({ status, data } = await fetchJson('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ query: q, type: 'auto', numResults: 10 }),
    }, 6000));
  } catch (e) {
    throw new Error('exa lỗi mạng/timeout: ' + (e && e.message ? e.message : String(e)));
  }
  if (status === 402) throw quotaError('exa', 402);
  if (status !== 200 || !data) throw new Error('exa HTTP ' + status);
  const results = toResults((data.results || []).map((r) => ({
    title: r.title, url: r.url, snippet: r.text || '',
  })));
  if (!results.length) throw new Error('exa: 0 kết quả');
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
  const tavilyKey = (process.env.TAVILY_API_KEY || '').trim();
  const serperKey = (process.env.SERPER_API_KEY || '').trim();
  const exaKey = (process.env.EXA_API_KEY || '').trim();
  const attempts = [];
  if (tavilyKey) attempts.push(['tavily', () => searchTavily(q, tavilyKey)]);
  attempts.push(['tavily-keyless', () => searchTavily(q, null)]);
  if (serperKey) attempts.push(['serper', () => searchSerper(q, serperKey)]);
  if (exaKey) attempts.push(['exa', () => searchExa(q, exaKey)]);
  let lastErr = '';
  let quotaOnly = true;
  for (const [name, fn] of attempts) {
    try {
      const results = (await fn()).slice(0, 10).map(clean);
      if (results.length) {
        CACHE.set(key, { t: Date.now(), source: name, results });
        res.status(200).json({ ok: true, source: name, results });
        return;
      }
      lastErr = name + ': không có kết quả';
      quotaOnly = false;
    } catch (e) {
      lastErr = name + ': ' + (e && e.message ? e.message : String(e));
      if (!e || !e.quota) quotaOnly = false;
    }
  }
  // Hết lượt miễn phí ở mọi nguồn (khác với lỗi mạng): game hiện dòng
  // "Hết lượt tìm miễn phí tháng này, thử lại mùng 1" thay vì tưởng game hỏng.
  res.status(502).json({
    ok: false,
    quota_exhausted: quotaOnly && attempts.length > 0,
    error: (quotaOnly
      ? 'Đã hết lượt tìm miễn phí tháng này, thử lại vào mùng 1.'
      : 'Không tìm được kết quả web. (' + lastErr + ')'),
    details: lastErr,
  });
};

// Cho phép nâng timeout hàm trên gói Hobby (mặc định 10s, tối đa 60s):
module.exports.config = { maxDuration: 30 };
