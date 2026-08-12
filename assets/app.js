// 기사검색 — 브라우저에서 Claude API(Messages)를 직접 호출한다.
//  · 검색 및 분석: 키워드 → web_search 로 최신 기사 수집 → 핵심/언론사별 비교/공통 팩트/초등학생 설명
//  · 기사요약:    링크  → web_fetch 로 본문 열람 → 제목·핵심요약 + web_search 로 관련 기사
// API 키는 이 기기(localStorage)에만 저장되고, 요청은 브라우저 → api.anthropic.com 으로 바로 나간다.

const API_URL = 'https://api.anthropic.com/v1/messages';
const K_KEY = 'as-api-key';
const K_MODEL = 'as-model';
const K_NOEFFORT = 'as-no-effort';    // effort 를 거부한 모델 기록 — 다음부터 안 보냄
const K_BASICTOOLS = 'as-basic-tools'; // 최신 웹검색 도구를 거부한 모델 기록
const K_USAGE = 'as-usage';         // 실제 사용량 기록 [{at, kind, model, cost, in, out, searches}]
const K_ORDER = 'as-sec-order';     // 검색 결과 카드 순서 (드래그로 바꾼 값)
const K_RECENT = 'as-recent';       // { search: [...], url: [...] }
const K_CACHE = 'as-cache';         // { "s:키워드": {at, data}, "u:링크": {at, data} }
const CACHE_TTL = 6 * 60 * 60 * 1000;   // 6시간 — 같은 검색을 다시 열 때 요금이 또 나가지 않게
const MAX_RECENT = 8;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const getKey = () => localStorage.getItem(K_KEY) || '';
const getModel = () => localStorage.getItem(K_MODEL) || 'claude-opus-5';

// effort(응답 깊이 조절)는 모델마다 지원 여부가 다르다. Haiku 4.5 는 지원하지 않고,
// 계정·모델에 따라 거부되는 경우도 있어 400 이 오면 그 모델을 기억해 두고 빼고 재시도한다.
const EFFORT_MODELS = { 'claude-opus-5': 1, 'claude-sonnet-5': 1 };
const effortBlocked = m => (loadJSON(K_NOEFFORT, {})[m] === true);
function blockEffort(m) { const o = loadJSON(K_NOEFFORT, {}); o[m] = true; saveJSON(K_NOEFFORT, o); }
const useEffort = m => !!EFFORT_MODELS[m] && !effortBlocked(m);

// 웹검색·웹읽기 도구도 최신판(_20260209)은 내부적으로 코드실행을 써서 상위 모델에서만 돈다.
// Haiku 4.5 등에서는 기본판을 써야 한다. 400 이 오면 기록해 두고 기본판으로 내려간다.
const MODERN_TOOL_MODELS = { 'claude-opus-5': 1, 'claude-sonnet-5': 1 };
const useModernTools = m => !!MODERN_TOOL_MODELS[m] && loadJSON(K_BASICTOOLS, {})[m] !== true;
function blockModernTools(m) { const o = loadJSON(K_BASICTOOLS, {}); o[m] = true; saveJSON(K_BASICTOOLS, o); }

function toolsFor(kind, model) {
  const modern = useModernTools(model);
  const search = modern
    ? { type: 'web_search_20260209', name: 'web_search', max_uses: 8 }
    : { type: 'web_search_20250305', name: 'web_search', max_uses: 8 };
  if (kind === 'search') return [search];
  const fetchTool = modern
    ? { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 4 }
    : { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 4 };
  return [fetchTool, { ...search, max_uses: 5 }];
}

function loadJSON(k, dflt) {
  try { return JSON.parse(localStorage.getItem(k) || '') ?? dflt; } catch (_) { return dflt; }
}
function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }

// ── 요금 (공식 단가, 100만 토큰당 USD) ────────
// 캐시 읽기는 입력가의 0.1배, 캐시 쓰기는 1.25배. 웹검색은 1,000회당 $10.
const MODEL_INFO = {
  'claude-opus-5':    { label: 'Claude Opus 5',   note: '가장 똑똑함 · 가장 비쌈', in: 5, out: 25 },
  'claude-sonnet-5':  { label: 'Claude Sonnet 5', note: '속도·품질·가격 균형 (추천)', in: 3, out: 15,
                        introIn: 2, introOut: 10, introUntil: '2026-08-31' },
  'claude-haiku-4-5': { label: 'Claude Haiku 4.5', note: '가장 저렴 · 분석 품질 낮음', in: 1, out: 5 },
};
const WEB_SEARCH_USD = 0.01;   // 검색 1회
const KRW_PER_USD = 1400;      // 표시용 어림값 — 실제 환율과 다를 수 있음

function rateOf(model) {
  const m = MODEL_INFO[model] || MODEL_INFO['claude-opus-5'];
  const onIntro = m.introUntil && new Date().toISOString().slice(0, 10) <= m.introUntil;
  return { in: onIntro ? m.introIn : m.in, out: onIntro ? m.introOut : m.out, onIntro: !!onIntro };
}
function costOf(model, u) {
  const r = rateOf(model);
  return (u.in / 1e6) * r.in
       + (u.cacheRead / 1e6) * r.in * 0.1
       + (u.cacheWrite / 1e6) * r.in * 1.25
       + (u.out / 1e6) * r.out
       + (u.searches || 0) * WEB_SEARCH_USD;
}
const usd = n => '$' + (n < 0.01 ? n.toFixed(4) : n.toFixed(3));
const krw = n => '약 ' + Math.round(n * KRW_PER_USD).toLocaleString('ko-KR') + '원';

function logUsage(kind, model, u) {
  const log = loadJSON(K_USAGE, []);
  log.unshift({ at: Date.now(), kind, model, cost: costOf(model, u), in: u.in, out: u.out, searches: u.searches });
  saveJSON(K_USAGE, log.slice(0, 100));
}

// ── 결과 캐시 ────────────────────────────────
// 오래됐다고 버리지 않는다. 6시간이 지나면 '새로 검색할까요?' 로 물어보고 사용자가 고른다.
function cacheEntry(key) {
  const c = loadJSON(K_CACHE, {})[key];
  return (c && c.data) ? c : null;
}
const isStale = e => (Date.now() - e.at) > CACHE_TTL;

// 저장본 꺼내기. v5 이하는 { data, links } 로, v6부터는 { result, links } 로 저장했다.
// 예전 저장본도 읽히게 둘 다 받고, 모양이 이상하면 null 을 돌려 새로 검색하게 한다.
function cachePayload(entry) {
  const p = entry && entry.data;
  const result = p && (p.result || p.data);
  return (result && typeof result === 'object') ? { result, links: p.links || [] } : null;
}

function agoText(ts) {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return '방금 전';
  if (m < 60) return m + '분 전';
  const h = Math.round(m / 60);
  if (h < 24) return h + '시간 전';
  return Math.round(h / 24) + '일 전';
}
function whenText(ts) {
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function cachePut(key, data) {
  const c = loadJSON(K_CACHE, {});
  c[key] = { at: Date.now(), data };
  // 오래된 것부터 정리 — 최대 30건
  const keys = Object.keys(c).sort((a, b) => c[b].at - c[a].at).slice(30);
  keys.forEach(k => delete c[k]);
  saveJSON(K_CACHE, c);
}

// ── 최근 목록 ────────────────────────────────
function recentAdd(kind, value) {
  const r = loadJSON(K_RECENT, { search: [], url: [] });
  const list = (r[kind] || []).filter(v => v !== value);
  list.unshift(value);
  r[kind] = list.slice(0, MAX_RECENT);
  saveJSON(K_RECENT, r);
  renderRecent();
}
function renderRecent() {
  const r = loadJSON(K_RECENT, { search: [], url: [] });
  const chip = (v, label) => `<button class="rc" type="button" data-v="${esc(v)}">${esc(label)}</button>`;
  $('recent').innerHTML = (r.search || []).map(v => chip(v, v)).join('');
  $('recentUrl').innerHTML = (r.url || []).map(v => {
    let label = v; try { label = new URL(v).hostname.replace(/^www\./, '') + ' …'; } catch (_) {}
    return chip(v, label);
  }).join('');
  $('recent').querySelectorAll('.rc').forEach(b => b.onclick = () => { $('q').value = b.dataset.v; runSearch(); });
  $('recentUrl').querySelectorAll('.rc').forEach(b => b.onclick = () => { $('url').value = b.dataset.v; runDigest(); });
}

// ── Claude 호출 ──────────────────────────────
// 서버측 도구(web_search/web_fetch)는 stop_reason:"pause_turn" 으로 끊길 수 있어 이어서 재요청한다.
async function callClaude({ system, userText, kind, maxContinuations = 4 }) {
  const key = getKey();
  if (!key) throw new AppError('API 키가 없어요', '오른쪽 위 ⚙︎ 에서 Anthropic API 키를 넣어 주세요.');

  const model = getModel();
  let messages = [{ role: 'user', content: userText }];
  let out = [], searchLinks = [];
  const usage = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, searches: 0 };

  for (let i = 0; i <= maxContinuations; i++) {
    let res;
    // 모델이 지원하지 않는 옵션이 있으면 400 이 온다. 그 옵션을 한 단계씩 내려가며 다시 보낸다.
    for (let attempt = 0; ; attempt++) {
      const body = { model, max_tokens: 16000, system, tools: toolsFor(kind, model), messages };
      if (useEffort(model)) body.output_config = { effort: 'medium' };

      res = await postJSON(key, body);
      if (res.status !== 400 || attempt >= 2) break;

      const msg = await peekError(res);
      if (/effort/i.test(msg) && body.output_config) { blockEffort(model); continue; }
      if (/programmatic tool calling|allowed_callers/i.test(msg) && useModernTools(model)) {
        blockModernTools(model); continue;
      }
      throw errorFor(400, msg);
    }
    if (!res.ok) throw await httpError(res);
    const data = await res.json();

    const u = data.usage || {};
    usage.in += u.input_tokens || 0;
    usage.out += u.output_tokens || 0;
    usage.cacheRead += u.cache_read_input_tokens || 0;
    usage.cacheWrite += u.cache_creation_input_tokens || 0;
    usage.searches += (u.server_tool_use && u.server_tool_use.web_search_requests) || 0;

    for (const b of data.content || []) {
      if (b.type === 'text' && b.text) out.push(b.text);
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
        b.content.forEach(r => { if (r.url) searchLinks.push({ url: r.url, title: r.title || '' }); });
      }
    }

    if (data.stop_reason === 'refusal') {
      throw new AppError('답변이 거절됐어요',
        '이 주제는 안전 정책상 답할 수 없다고 나왔어요. 다른 검색어로 시도해 보세요.');
    }
    if (data.stop_reason === 'pause_turn') {          // 서버 도구가 아직 도는 중 — 그대로 이어붙여 재요청
      messages = [{ role: 'user', content: userText }, { role: 'assistant', content: data.content }];
      continue;
    }
    if (data.stop_reason === 'max_tokens') {
      out.push('\n\n(응답이 길어 잘렸어요)');
    }
    break;
  }
  logUsage(kind, model, usage);
  return { text: out.join('\n'), searchLinks };
}

class AppError extends Error {
  constructor(title, detail) { super(title); this.title = title; this.detail = detail || ''; }
}
function postJSON(key, body) {
  return fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  }).catch(e => { throw new AppError('네트워크 오류', '인터넷 연결을 확인해 주세요. (' + e.message + ')'); });
}
async function peekError(res) {
  try { const j = await res.json(); return (j.error && j.error.message) || ''; } catch (_) { return ''; }
}
function errorFor(status, msg) {
  if (status === 401) return new AppError('API 키가 올바르지 않아요', '⚙︎ 설정에서 키를 다시 확인해 주세요.');
  if (status === 403) return new AppError('권한이 없어요', msg || '이 키로는 이 모델을 쓸 수 없어요.');
  if (status === 404) return new AppError('모델을 찾을 수 없어요', '⚙︎ 설정에서 다른 모델을 골라 보세요. ' + msg);
  if (status === 429) return new AppError('요청이 너무 많아요', '잠시 뒤에 다시 시도해 주세요.');
  if (status >= 500) return new AppError('서버가 바빠요', '잠시 뒤에 다시 시도해 주세요. (' + status + ')');
  if (status === 400 && /does not support|not supported/i.test(msg)) {
    return new AppError('이 모델로는 안 되는 기능이에요',
      '⚙︎ 설정에서 Sonnet 5 나 Opus 5 로 바꾸면 됩니다. (' + msg + ')');
  }
  return new AppError('요청 실패 (' + status + ')', msg);
}
async function httpError(res) { return errorFor(res.status, await peekError(res)); }

// 응답에서 JSON 블록만 뽑아낸다 (```json … ``` 또는 첫 { … 마지막 })
function extractJSON(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// ── 프롬프트 ─────────────────────────────────
const RULES = `너는 한국 가족(부모와 초등학생)을 위한 뉴스 분석 도우미다.
- 반드시 웹에서 확인한 사실만 쓴다. 추측·예측·전망·창작은 금지한다.
- 숫자와 날짜는 기사에 나온 그대로 쓰고, 출처 언론사를 밝힌다.
- 확인하지 못한 내용은 지어내지 말고 note 에 적는다.
- 모든 값은 한국어로 쓴다.
- 설명 문장 없이 JSON 하나만 \`\`\`json 코드블록으로 출력한다.`;

const SEARCH_SYSTEM = `${RULES}

다음 스키마를 정확히 지켜 출력한다:
{
  "topic": "검색 주제를 한 줄로",
  "core": "핵심 내용 3~5문장. 무슨 일이 언제 어디서 일어났고 왜 중요한지",
  "outlets": [
    { "name": "언론사 이름", "angle": "이 매체가 특히 강조한 관점·표현·수치(1~2문장)", "url": "해당 기사 링크" }
  ],
  "common_facts": ["두 곳 이상의 매체가 공통으로 보도한 사실. 숫자·날짜 포함"],
  "kid": "초등학생이 이해할 수 있게 쉬운 말로 4~6문장. 어려운 용어는 괄호로 풀어서 설명",
  "sources": [ { "title": "기사 제목", "outlet": "언론사", "url": "링크" } ],
  "note": "정보가 부족하거나 매체마다 엇갈린 부분. 없으면 빈 문자열"
}

작성 규칙:
- 먼저 web_search 로 최근 기사를 여러 번 검색해 서로 다른 언론사 기사를 모은다.
- outlets 는 서로 다른 언론사 2~5곳. 같은 사실을 어떻게 다르게 다뤘는지 비교한다.
- common_facts 는 2곳 이상에서 확인된 사실만 3~6개.
- sources 는 실제로 읽은 기사만 3~6개.`;

const DIGEST_SYSTEM = `${RULES}

다음 스키마를 정확히 지켜 출력한다:
{
  "title": "기사 제목(원문 그대로)",
  "outlet": "언론사",
  "published": "발행일(알 수 있으면 YYYY-MM-DD, 모르면 빈 문자열)",
  "summary": ["핵심 내용 요약 3~6개. 한 항목당 한 문장"],
  "related": [ { "title": "관련 기사 제목", "outlet": "언론사", "url": "링크" } ],
  "note": "본문을 못 읽었거나 확인 안 된 부분. 없으면 빈 문자열"
}

작성 규칙:
- 먼저 web_fetch 로 사용자가 준 링크의 본문을 읽는다.
- summary 는 기사에 실제로 있는 내용만. 기사에 없는 배경 설명을 덧붙이지 않는다.
- related 는 web_search 로 찾은 같은 사건·주제의 다른 기사 3~5개(가능하면 다른 언론사).
- 본문을 못 읽으면 title 에 알아낸 만큼만 쓰고 note 에 이유를 적는다.`;


// ── 물어보기 팝업 ────────────────────────────
function askDialog({ icon, title, lines, yes, no }) {
  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.className = 'sheet';
    ov.innerHTML = `<div class="sheet-box ask-box">
      <h2 class="ask-title">${icon} ${esc(title)}</h2>
      ${lines.map(l => `<p class="ask-line">${l}</p>`).join('')}
      <div class="sheet-btns ask-btns">
        <button class="go" type="button" data-a="1">${esc(yes)}</button>
        <button class="ghost" type="button" data-a="0">${esc(no)}</button>
      </div></div>`;
    document.body.appendChild(ov);
    const done = v => { ov.remove(); resolve(v); };
    ov.querySelector('[data-a="1"]').onclick = () => done(true);
    ov.querySelector('[data-a="0"]').onclick = () => done(false);
    ov.onclick = e => { if (e.target === ov) done(false); };   // 바깥을 누르면 '아니요'
  });
}

// 저장된 결과가 6시간을 넘었을 때만 물어본다. true = 새로 검색
function askRefresh(label, at, kind) {
  const log = loadJSON(K_USAGE, []).filter(e => e.kind === kind);
  const avg = log.length ? log.reduce((s, e) => s + e.cost, 0) / log.length : null;
  return askDialog({
    icon: '🕓', title: '새로 검색할까요?',
    lines: [
      `<b>${esc(label)}</b>`,
      `저장된 결과는 <b>${whenText(at)}</b>에 찾은 거예요 (${agoText(at)}).`,
      avg != null
        ? `새로 검색하면 최신 기사를 찾지만 요금이 들어요 — 평균 ${usd(avg)} (${krw(avg)}).`
        : '새로 검색하면 최신 기사를 찾지만 요금이 들어요.',
    ],
    yes: '예, 새로 검색', no: '아니요, 저장된 결과 보기',
  });
}

// 저장된 결과를 보여줄 때 맨 위에 붙는 안내줄 (여기서도 바로 새로 검색 가능)
function markCached(box, at, onRefresh) {
  const bar = document.createElement('div');
  bar.className = 'cached-bar' + ((Date.now() - at) > CACHE_TTL ? ' old' : '');
  bar.innerHTML = `<span>🕓 ${esc(whenText(at))}에 검색한 결과예요 (${agoText(at)})</span>
    <button class="mini" type="button">새로 검색</button>`;
  bar.querySelector('.mini').onclick = onRefresh;
  box.insertBefore(bar, box.firstChild);
}

// ── 로딩 표시 ────────────────────────────────
let _timer = null;
function showLoading(box, label) {
  const t0 = Date.now();
  box.innerHTML = `<div class="loading"><div class="spin"></div>${esc(label)}
    <span class="elapsed" id="el">0초</span></div>`;
  clearInterval(_timer);
  _timer = setInterval(() => {
    const el = $('el'); if (!el) return clearInterval(_timer);
    el.textContent = Math.round((Date.now() - t0) / 1000) + '초 — 검색하고 정리하는 중이에요';
  }, 1000);
}
function stopLoading() { clearInterval(_timer); _timer = null; }
function showError(box, e) {
  stopLoading();
  const err = (e instanceof AppError) ? e : new AppError('문제가 생겼어요', e.message || '');
  box.innerHTML = `<div class="err"><b>${esc(err.title)}</b>${esc(err.detail)}</div>`;
}

// ── 렌더 ─────────────────────────────────────
function linkList(items) {
  return `<div class="srcs">${items.map(s => `
    <a class="src" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">
      <span class="t">${esc(s.title || s.url)}</span>
      <span class="m">${esc(s.outlet || hostOf(s.url))} ↗</span>
    </a>`).join('')}</div>`;
}
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return ''; } }

// 카드 제목줄(h3)을 잡고 끌면 순서를 바꿀 수 있다. 바꾼 순서는 다음 검색에도 이어진다.
const DEFAULT_ORDER = ['core', 'outlets', 'facts', 'kid', 'sources'];
function getOrder() {
  const o = loadJSON(K_ORDER, null);
  if (!Array.isArray(o) || o.length !== DEFAULT_ORDER.length
      || !DEFAULT_ORDER.every(k => o.includes(k))) return DEFAULT_ORDER.slice();
  return o;
}
function sec(key, cls, title, inner) {
  return `<section class="sec ${cls}" data-sec="${key}">
    <h3>${title}<span class="grip" aria-hidden="true">⋮⋮</span></h3>${inner}</section>`;
}

function renderSearch(box, d, fallbackLinks) {
  d = d || {};
  const outlets = (d.outlets || []).filter(o => o && o.name);
  const facts = (d.common_facts || []).filter(Boolean);
  let sources = (d.sources || []).filter(s => s && s.url);
  if (!sources.length && fallbackLinks && fallbackLinks.length) {
    sources = fallbackLinks.slice(0, 6).map(l => ({ title: l.title, url: l.url }));
  }

  const blocks = {
    core: d.core ? sec('core', '', '📌 핵심 내용', `<p>${esc(d.core)}</p>`) : '',
    outlets: outlets.length ? sec('outlets', 's-outlet', '📰 언론사별 비교', `
      <div class="outlets">${outlets.map(o => `
        <div class="ot">
          <div class="ot-name">${esc(o.name)}</div>
          <p class="ot-angle">${esc(o.angle || '')}</p>
          ${o.url ? `<a href="${esc(o.url)}" target="_blank" rel="noopener noreferrer">기사 보기 ↗</a>` : ''}
        </div>`).join('')}</div>`) : '',
    facts: facts.length ? sec('facts', 's-fact', '✅ 공통 팩트',
      `<ul class="bul">${facts.map(f => `<li>${esc(f)}</li>`).join('')}</ul>`) : '',
    kid: d.kid ? sec('kid', 's-kid', '🧒 초등학생이 이해하기 쉬운 설명', `<p>${esc(d.kid)}</p>`) : '',
    sources: sources.length ? sec('sources', '', '🔗 참고한 기사', linkList(sources)) : '',
  };

  box.innerHTML =
    `<h2 class="topic">${esc(d.topic || '')}</h2>` +
    `<p class="drag-hint">⋮⋮ 제목을 손가락으로 끌면 순서를 바꿀 수 있어요</p>` +
    `<div class="secs" id="secs">${getOrder().map(k => blocks[k] || '').join('')}</div>` +
    (d.note ? `<p class="note">ℹ️ ${esc(d.note)}</p>` : '');

  bindReorder($('secs'));
}

// ── 카드 순서 바꾸기(드래그) ─────────────────
// 제목줄에서만 시작한다 — 본문에서는 평소처럼 스크롤되게.
function bindReorder(list) {
  if (!list) return;
  let drag = null;

  const flip = (mutate, skip) => {          // 다른 카드들이 툭 튀지 않고 미끄러지게
    const els = [...list.children];
    const before = new Map(els.map(el => [el, el.getBoundingClientRect().top]));
    mutate();
    for (const el of els) {
      if (el === skip) continue;
      const dy = before.get(el) - el.getBoundingClientRect().top;
      if (!dy) continue;
      el.style.transition = 'none';
      el.style.transform = `translateY(${dy}px)`;
      requestAnimationFrame(() => {
        el.style.transition = 'transform .18s ease';
        el.style.transform = '';
      });
    }
  };

  list.addEventListener('pointerdown', e => {
    const head = e.target.closest('h3');
    if (!head || head.parentElement.parentElement !== list) return;
    const el = head.parentElement;
    drag = { el, startY: e.clientY };
    el.classList.add('dragging');
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
  });

  list.addEventListener('pointermove', e => {
    if (!drag) return;
    e.preventDefault();
    drag.el.style.transform = `translateY(${e.clientY - drag.startY}px)`;

    for (const other of list.children) {
      if (other === drag.el) continue;
      const r = other.getBoundingClientRect();
      if (e.clientY < r.top || e.clientY > r.bottom) continue;
      const down = e.clientY > r.top + r.height / 2;
      const visualTop = drag.el.getBoundingClientRect().top;
      flip(() => { down ? other.after(drag.el) : other.before(drag.el); }, drag.el);
      // DOM 위치가 바뀌어도 카드가 손가락 아래 그대로 있도록 기준점을 다시 잡는다
      drag.el.style.transform = '';
      drag.startY = e.clientY - (visualTop - drag.el.getBoundingClientRect().top);
      drag.el.style.transform = `translateY(${e.clientY - drag.startY}px)`;
      break;
    }

    const m = 70, vh = window.innerHeight;      // 화면 끝에 닿으면 따라 스크롤
    if (e.clientY < m) window.scrollBy(0, -12);
    else if (e.clientY > vh - m) window.scrollBy(0, 12);
  });

  const end = () => {
    if (!drag) return;
    drag.el.classList.remove('dragging');
    drag.el.style.transition = 'transform .16s ease';
    drag.el.style.transform = '';
    setTimeout(() => { if (drag) drag.el.style.transition = ''; }, 180);
    const order = [...list.children].map(el => el.dataset.sec).filter(Boolean);
    // 이번 결과에 없는 항목은 기존 순서를 지켜 뒤에 붙인다
    saveJSON(K_ORDER, order.concat(getOrder().filter(k => !order.includes(k))));
    drag = null;
  };
  list.addEventListener('pointerup', end);
  list.addEventListener('pointercancel', end);
}

function renderDigest(box, d) {
  d = d || {};
  const summary = (d.summary || []).filter(Boolean);
  const related = (d.related || []).filter(r => r && r.url);
  const meta = [d.outlet, d.published].filter(Boolean).join(' · ');
  box.innerHTML =
    `<h2 class="topic">${esc(d.title || '(제목을 찾지 못했어요)')}</h2>` +
    (meta ? `<p class="meta">${esc(meta)}</p>` : '') +
    (summary.length ? `<section class="sec"><h3>📌 핵심 내용 요약</h3>
      <ul class="bul">${summary.map(s => `<li>${esc(s)}</li>`).join('')}</ul></section>` : '') +
    (related.length ? `<section class="sec s-outlet"><h3>🔗 관련 기사 (참고용)</h3>${linkList(related)}</section>` : '') +
    (d.note ? `<p class="note">ℹ️ ${esc(d.note)}</p>` : '');
}

function renderRaw(box, text) {   // JSON 파싱 실패 시 원문이라도 보여준다
  box.innerHTML = `<section class="sec"><h3>📄 결과</h3><p>${esc(text).replace(/\n/g, '<br>')}</p></section>`;
}

// ── 동작 ─────────────────────────────────────
let busy = false;

// 예외가 나도 조용히 죽지 않게 — 무슨 일이 났는지 화면에 띄운다
function runSearch(opts) {
  return Promise.resolve().then(() => searchFlow(opts || {}))
    .catch(e => { console.error(e); showError($('searchResult'), e); });
}
function runDigest(opts) {
  return Promise.resolve().then(() => digestFlow(opts || {}))
    .catch(e => { console.error(e); showError($('digestResult'), e); });
}

async function searchFlow(opts) {
  const q = $('q').value.trim();
  const box = $('searchResult');
  if (!q || busy) return;
  window.scrollTo({ top: 0, behavior: 'smooth' });

  // 저장된 결과가 있으면 기본은 그것을 보여준다.
  // 6시간이 지났을 때만 새로 검색할지 물어보고, '예'를 눌렀을 때만 새로 찾는다.
  const entry = opts.force ? null : cacheEntry('s:' + q);
  const saved = cachePayload(entry);
  if (saved) {
    const showSaved = !isStale(entry) || !(await askRefresh(q, entry.at, 'search'));
    if (showSaved) {
      renderSearch(box, saved.result, saved.links);
      markCached(box, entry.at, () => runSearch({ force: true }));
      recentAdd('search', q);
      return;
    }
  }

  busy = true; $('searchForm').querySelector('.go').disabled = true;
  showLoading(box, `"${q}" 기사를 찾는 중…`);
  try {
    const { text, searchLinks } = await callClaude({
      system: SEARCH_SYSTEM,
      userText: `검색어: ${q}\n\n이 주제의 최근 기사를 여러 언론사에서 찾아 스키마대로 정리해 줘.`,
      kind: 'search',
    });
    stopLoading();
    const d = extractJSON(text);
    if (d) { renderSearch(box, d, searchLinks); cachePut('s:' + q, { result: d, links: searchLinks }); }
    else renderRaw(box, text);
    recentAdd('search', q);
  } catch (e) { showError(box, e); }
  finally { busy = false; $('searchForm').querySelector('.go').disabled = false; }
}

async function digestFlow(opts) {
  const u = $('url').value.trim();
  const box = $('digestResult');
  if (!u || busy) return;
  if (!/^https?:\/\//i.test(u)) {
    showError(box, new AppError('링크 형식이 아니에요', 'http:// 또는 https:// 로 시작하는 기사 주소를 붙여넣어 주세요.'));
    return;
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });

  const entry = opts.force ? null : cacheEntry('u:' + u);
  const saved = cachePayload(entry);
  if (saved) {
    let label = u; try { label = new URL(u).hostname.replace(/^www\./, ''); } catch (_) {}
    const showSaved = !isStale(entry) || !(await askRefresh(label, entry.at, 'digest'));
    if (showSaved) {
      renderDigest(box, saved.result);
      markCached(box, entry.at, () => runDigest({ force: true }));
      recentAdd('url', u);
      return;
    }
  }

  busy = true; $('digestForm').querySelector('.go').disabled = true;
  showLoading(box, '기사를 읽는 중…');
  try {
    const { text } = await callClaude({
      system: DIGEST_SYSTEM,
      userText: `기사 링크: ${u}\n\n이 기사를 읽고 스키마대로 요약해 줘. 관련 기사도 찾아 줘.`,
      kind: 'digest',
    });
    stopLoading();
    const d = extractJSON(text);
    if (d) { renderDigest(box, d); cachePut('u:' + u, { result: d }); }
    else renderRaw(box, text);
    recentAdd('url', u);
  } catch (e) { showError(box, e); }
  finally { busy = false; $('digestForm').querySelector('.go').disabled = false; }
}

// ── 정보 탭 ──────────────────────────────────
function kv(k, v) { return `<div class="kv"><span>${k}</span><b>${v}</b></div>`; }

function renderInfo() {
  const model = getModel();
  const mi = MODEL_INFO[model] || { label: model, note: '' };
  const r = rateOf(model);
  const log = loadJSON(K_USAGE, []);
  const pick = k => log.filter(e => e.kind === k);
  const avg = a => a.length ? a.reduce((s, e) => s + e.cost, 0) / a.length : null;
  const sAvg = avg(pick('search')), dAvg = avg(pick('digest'));
  const total = log.reduce((s, e) => s + e.cost, 0);
  const last = log[0];

  // 실측이 없을 때 보여줄 대략치 — 웹검색 3~6회 + 입력 2만~5만 토큰 + 출력 1.5천~3천 토큰 가정
  const estLo = costOf(model, { in: 20000, out: 1500, cacheRead: 0, cacheWrite: 0, searches: 3 });
  const estHi = costOf(model, { in: 50000, out: 3000, cacheRead: 0, cacheWrite: 0, searches: 6 });

  const measured = log.length ? `
      ${last ? kv('가장 최근 1회', `${usd(last.cost)} <small>(${krw(last.cost)})</small>`) : ''}
      ${sAvg != null ? kv('검색 및 분석 평균', `${usd(sAvg)} <small>(${krw(sAvg)})</small>`) : ''}
      ${dAvg != null ? kv('기사요약 평균', `${usd(dAvg)} <small>(${krw(dAvg)})</small>`) : ''}
      ${kv(`지금까지 ${log.length}회 누계`, `${usd(total)} <small>(${krw(total)})</small>`)}
      <p class="tiny">이 기기에서 실제로 쓴 토큰·검색 횟수로 계산한 값이에요.
        모델을 바꾸면 평균도 달라집니다.</p>`
    : `
      ${kv('예상 1회 비용', `${usd(estLo)} ~ ${usd(estHi)}`)}
      <p class="tiny">아직 검색 기록이 없어 <b>대략치</b>예요. 한 번 검색하면 실제 사용량으로 다시 계산해 보여줍니다.</p>`;

  $('infoBody').innerHTML = `
    <section class="sec">
      <h3>🤖 지금 쓰는 모델</h3>
      <div class="model-now">${esc(mi.label || model)}</div>
      <p class="tiny">${esc(mi.note || '')} · <code>${esc(model)}</code></p>
      ${kv('입력 요금', `$${r.in} <small>/ 100만 토큰</small>`)}
      ${kv('출력 요금', `$${r.out} <small>/ 100만 토큰</small>`)}
      ${kv('웹검색 요금', `$${WEB_SEARCH_USD} <small>/ 검색 1회</small>`)}
      ${r.onIntro ? `<p class="tiny">※ 지금은 출시 기념 할인가예요. ${esc(MODEL_INFO[model].introUntil)}까지.</p>` : ''}
      <button class="ghost wide" id="infoModelBtn" type="button">⚙︎ 모델 바꾸기</button>
    </section>

    <section class="sec s-fact">
      <h3>💰 1회 검색당 비용</h3>
      ${measured}
      <p class="tiny">환율은 1달러 ${KRW_PER_USD.toLocaleString('ko-KR')}원으로 어림잡은 값이라
        실제 청구액과 차이가 납니다. 정확한 금액은
        <a href="https://console.anthropic.com/settings/usage" target="_blank" rel="noopener noreferrer">콘솔 사용량 ↗</a>에서 보세요.</p>
      <p class="tiny">한 번 찾은 검색어·링크는 저장돼요. 다시 열면 <b>저장된 결과를 먼저 보여주니 0원</b>이고,
        6시간이 지났으면 새로 검색할지 물어봅니다. <b>예</b>를 눌렀을 때만 요금이 들어요.</p>
    </section>

    <section class="sec s-kid">
      <h3>📖 사용방법</h3>
      <ol class="bul howto">
        <li><b>검색 및 분석</b> — 궁금한 낱말이나 사건을 넣고 검색을 누르면, 여러 언론사 기사를 찾아
          <b>핵심 내용 · 언론사별 비교 · 공통 팩트 · 초등학생 눈높이 설명</b>으로 정리해 줘요.
          30초~1분쯤 걸립니다.</li>
        <li><b>기사요약</b> — 읽던 기사의 주소를 복사해 붙여넣고 요약을 누르면
          <b>제목과 핵심 내용</b>을 간추리고 <b>관련 기사 링크</b>를 같이 보여줘요.</li>
        <li>검색 결과의 <b>카드 제목줄(⋮⋮)을 손가락으로 끌면</b> 순서를 바꿀 수 있어요.
          바꾼 순서는 다음 검색에도 그대로 이어집니다. 카드 본문은 평소처럼 스크롤돼요.</li>
        <li>입력칸 아래 <b>최근 목록</b>을 누르면 저장해 둔 결과를 <b>요금 없이</b> 다시 봅니다.
          6시간이 지난 결과라면 <b>“새로 검색할까요?”</b>를 물어보고, <b>예</b>를 눌렀을 때만 새로 찾아요.
          결과 위 <b>새로 검색</b> 버튼으로도 언제든 새로 찾을 수 있어요.</li>
        <li>결과의 <b>기사 보기 ↗</b> 를 누르면 원문으로 갑니다. 중요한 내용은 원문으로 확인하세요.</li>
      </ol>
      <button class="ghost wide" id="infoOrderBtn" type="button">↕︎ 카드 순서 처음으로 되돌리기</button>
      <h3 style="margin-top:14px">💡 알아두면 좋은 것</h3>
      <ul class="bul">
        <li>API 키는 <b>이 기기에만</b> 저장돼요. 다른 기기에서는 ⚙︎ 에서 한 번 더 넣어야 합니다.</li>
        <li>비용을 아끼려면 ⚙︎ 에서 <b>Sonnet 5</b>를 쓰세요. Opus 5는 더 똑똑하지만 몇 배 비쌉니다.</li>
        <li>검색으로 확인된 사실만 쓰도록 해 뒀지만, <b>AI가 틀릴 수 있어요.</b>
          숫자나 중요한 내용은 원문 기사로 꼭 확인하세요.</li>
        <li>기록을 지우려면 ⚙︎ → <b>저장된 결과 지우기</b>.</li>
      </ul>
    </section>`;

  const mb = $('infoModelBtn'); if (mb) mb.onclick = openSheet;
  const ob = $('infoOrderBtn');
  if (ob) ob.onclick = () => {
    localStorage.removeItem(K_ORDER);
    ob.textContent = '↩︎ 처음 순서로 되돌렸어요';
    setTimeout(() => { ob.textContent = '↕︎ 카드 순서 처음으로 되돌리기'; }, 1800);
  };
}

// ── 탭 · 설정 ────────────────────────────────
function bindTabs() {
  document.querySelectorAll('#viewtabs .vtab').forEach(btn => {
    btn.onclick = () => {
      const v = btn.dataset.view;
      document.querySelectorAll('#viewtabs .vtab').forEach(b => {
        const on = b === btn;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      $('view-search').classList.toggle('hidden', v !== 'search');
      $('view-digest').classList.toggle('hidden', v !== 'digest');
      $('view-info').classList.toggle('hidden', v !== 'info');
      if (v === 'info') renderInfo();          // 열 때마다 최신 사용량으로 다시 계산
      window.scrollTo({ top: 0 });
    };
  });
}

function openSheet() {
  $('apiKey').value = getKey();
  $('model').value = getModel();
  $('sheet').classList.remove('hidden');
}
function bindSheet() {
  $('settingsBtn').onclick = openSheet;
  $('sheetClose').onclick = () => $('sheet').classList.add('hidden');
  $('sheet').onclick = e => { if (e.target === $('sheet')) $('sheet').classList.add('hidden'); };
  $('saveKey').onclick = () => {
    const k = $('apiKey').value.trim();
    if (k) localStorage.setItem(K_KEY, k); else localStorage.removeItem(K_KEY);
    localStorage.setItem(K_MODEL, $('model').value);
    $('sheet').classList.add('hidden');
    if (!$('view-info').classList.contains('hidden')) renderInfo();   // 모델이 바뀌었을 수 있다
  };
  $('clearCache').onclick = () => {
    if (!confirm('저장된 검색 결과 · 최근 목록 · 비용 기록을 모두 지울까요?\n(API 키와 모델 설정은 그대로예요)')) return;
    [K_CACHE, K_RECENT, K_USAGE].forEach(k => localStorage.removeItem(k));
    renderRecent();
    if (!$('view-info').classList.contains('hidden')) renderInfo();
    alert('지웠어요.');
  };
}

document.addEventListener('DOMContentLoaded', () => {
  bindTabs();
  bindSheet();
  renderRecent();
  $('searchForm').onsubmit = e => { e.preventDefault(); runSearch(); };
  $('digestForm').onsubmit = e => { e.preventDefault(); runDigest(); };
  if (!getKey()) openSheet();     // 첫 실행 — 키부터 받는다
});
