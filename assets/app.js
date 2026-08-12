// 기사검색 — 브라우저에서 Claude API(Messages)를 직접 호출한다.
//  · 검색 및 분석: 키워드 → web_search 로 최신 기사 수집 → 핵심/언론사별 비교/공통 팩트/초등학생 설명
//  · 기사요약:    링크  → web_fetch 로 본문 열람 → 제목·핵심요약 + web_search 로 관련 기사
// API 키는 이 기기(localStorage)에만 저장되고, 요청은 브라우저 → api.anthropic.com 으로 바로 나간다.

const API_URL = 'https://api.anthropic.com/v1/messages';
const K_KEY = 'as-api-key';
const K_MODEL = 'as-model';
const K_NOEFFORT = 'as-no-effort';  // effort 를 거부한 모델 기록 — 다음부터 안 보냄
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

function loadJSON(k, dflt) {
  try { return JSON.parse(localStorage.getItem(k) || '') ?? dflt; } catch (_) { return dflt; }
}
function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }

// ── 결과 캐시 ────────────────────────────────
function cacheGet(key) {
  const c = loadJSON(K_CACHE, {})[key];
  if (!c || (Date.now() - c.at) > CACHE_TTL) return null;
  return c.data;
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
async function callClaude({ system, userText, tools, maxContinuations = 4 }) {
  const key = getKey();
  if (!key) throw new AppError('API 키가 없어요', '오른쪽 위 ⚙︎ 에서 Anthropic API 키를 넣어 주세요.');

  const model = getModel();
  let messages = [{ role: 'user', content: userText }];
  let out = [], searchLinks = [];

  for (let i = 0; i <= maxContinuations; i++) {
    const body = { model, max_tokens: 16000, system, tools, messages };
    if (useEffort(model)) body.output_config = { effort: 'medium' };

    let res = await postJSON(key, body);
    // 이 모델이 effort 를 거부하면 기록해 두고 즉시 다시 보낸다(사용자에겐 그냥 성공한 것처럼 보임)
    if (res.status === 400 && body.output_config) {
      const msg = await peekError(res);
      if (/effort/i.test(msg)) {
        blockEffort(model);
        delete body.output_config;
        res = await postJSON(key, body);
      } else {
        throw errorFor(400, msg);
      }
    }
    if (!res.ok) throw await httpError(res);
    const data = await res.json();

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

const TOOLS_SEARCH = [{ type: 'web_search_20260209', name: 'web_search', max_uses: 8 }];
const TOOLS_DIGEST = [
  { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 4 },
  { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
];

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

function renderSearch(box, d, fallbackLinks) {
  const outlets = (d.outlets || []).filter(o => o && o.name);
  const facts = (d.common_facts || []).filter(Boolean);
  let sources = (d.sources || []).filter(s => s && s.url);
  if (!sources.length && fallbackLinks && fallbackLinks.length) {
    sources = fallbackLinks.slice(0, 6).map(l => ({ title: l.title, url: l.url }));
  }
  box.innerHTML =
    `<h2 class="topic">${esc(d.topic || '')}</h2>` +
    (d.core ? `<section class="sec"><h3>📌 핵심 내용</h3><p>${esc(d.core)}</p></section>` : '') +
    (outlets.length ? `<section class="sec s-outlet"><h3>📰 언론사별 비교</h3>
      <div class="outlets">${outlets.map(o => `
        <div class="ot">
          <div class="ot-name">${esc(o.name)}</div>
          <p class="ot-angle">${esc(o.angle || '')}</p>
          ${o.url ? `<a href="${esc(o.url)}" target="_blank" rel="noopener noreferrer">기사 보기 ↗</a>` : ''}
        </div>`).join('')}</div></section>` : '') +
    (facts.length ? `<section class="sec s-fact"><h3>✅ 공통 팩트</h3>
      <ul class="bul">${facts.map(f => `<li>${esc(f)}</li>`).join('')}</ul></section>` : '') +
    (d.kid ? `<section class="sec s-kid"><h3>🧒 초등학생이 이해하기 쉬운 설명</h3><p>${esc(d.kid)}</p></section>` : '') +
    (sources.length ? `<section class="sec"><h3>🔗 참고한 기사</h3>${linkList(sources)}</section>` : '') +
    (d.note ? `<p class="note">ℹ️ ${esc(d.note)}</p>` : '');
}

function renderDigest(box, d) {
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

async function runSearch() {
  const q = $('q').value.trim();
  const box = $('searchResult');
  if (!q || busy) return;
  window.scrollTo({ top: 0, behavior: 'smooth' });

  const cached = cacheGet('s:' + q);
  if (cached) { renderSearch(box, cached.data, cached.links); recentAdd('search', q); return; }

  busy = true; $('searchForm').querySelector('.go').disabled = true;
  showLoading(box, `"${q}" 기사를 찾는 중…`);
  try {
    const { text, searchLinks } = await callClaude({
      system: SEARCH_SYSTEM,
      userText: `검색어: ${q}\n\n이 주제의 최근 기사를 여러 언론사에서 찾아 스키마대로 정리해 줘.`,
      tools: TOOLS_SEARCH,
    });
    stopLoading();
    const d = extractJSON(text);
    if (d) { renderSearch(box, d, searchLinks); cachePut('s:' + q, { data: d, links: searchLinks }); }
    else renderRaw(box, text);
    recentAdd('search', q);
  } catch (e) { showError(box, e); }
  finally { busy = false; $('searchForm').querySelector('.go').disabled = false; }
}

async function runDigest() {
  const u = $('url').value.trim();
  const box = $('digestResult');
  if (!u || busy) return;
  if (!/^https?:\/\//i.test(u)) {
    showError(box, new AppError('링크 형식이 아니에요', 'http:// 또는 https:// 로 시작하는 기사 주소를 붙여넣어 주세요.'));
    return;
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });

  const cached = cacheGet('u:' + u);
  if (cached) { renderDigest(box, cached.data); recentAdd('url', u); return; }

  busy = true; $('digestForm').querySelector('.go').disabled = true;
  showLoading(box, '기사를 읽는 중…');
  try {
    const { text } = await callClaude({
      system: DIGEST_SYSTEM,
      userText: `기사 링크: ${u}\n\n이 기사를 읽고 스키마대로 요약해 줘. 관련 기사도 찾아 줘.`,
      tools: TOOLS_DIGEST,
    });
    stopLoading();
    const d = extractJSON(text);
    if (d) { renderDigest(box, d); cachePut('u:' + u, { data: d }); }
    else renderRaw(box, text);
    recentAdd('url', u);
  } catch (e) { showError(box, e); }
  finally { busy = false; $('digestForm').querySelector('.go').disabled = false; }
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
  };
  $('clearCache').onclick = () => {
    localStorage.removeItem(K_CACHE); localStorage.removeItem(K_RECENT);
    renderRecent();
    alert('저장된 검색 결과와 최근 목록을 지웠어요.');
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
