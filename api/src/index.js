// 기사검색 — 결과 동기화 API (개인용, 토큰 보호)
// - GET /api/data : X-Edit-Token 일치 시 전체 결과 반환
// - PUT /api/data : X-Edit-Token 일치 시 전체 결과 저장
// KV: CACHE (단일 키 "as-cache")  ·  Secret: EDIT_TOKEN
//
// blog-writer-api 와 같은 계약이다. 다만 저장하는 것이 이력 배열이 아니라
// 캐시 항목 배열({key, at, data})이라서 valid() 가 한 겹 더 본다.
const KEY = 'as-cache';
const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED = ['https://junyoungcha83.github.io','http://localhost:8890','http://127.0.0.1:8890'];
function cors(req){ const o=req.headers.get('Origin')||''; const a=ALLOWED.includes(o)?o:ALLOWED[0];
  return { 'Access-Control-Allow-Origin':a,'Access-Control-Allow-Methods':'GET, PUT, OPTIONS','Access-Control-Allow-Headers':'Content-Type, X-Edit-Token','Access-Control-Max-Age':'86400','Vary':'Origin' }; }
function json(b,s,x){ return new Response(JSON.stringify(b),{status:s,headers:{'Content-Type':'application/json; charset=utf-8',...x}}); }
// 항목 하나는 { key:"s:…"|"u:…", at:숫자, data:{result,…} } 여야 한다.
const okItem = i => i && typeof i==='object'
  && typeof i.key==='string' && (i.key.startsWith('s:') || i.key.startsWith('u:'))
  && Number.isFinite(i.at)
  && i.data && typeof i.data==='object' && i.data.result && typeof i.data.result==='object';
const valid = p => p && typeof p==='object' && Array.isArray(p.items) && p.items.every(okItem);
export default {
  async fetch(req, env){
    const url = new URL(req.url), c = cors(req);
    if(req.method==='OPTIONS') return new Response(null,{headers:c});
    if(url.pathname==='/api/data'){
      const t = req.headers.get('X-Edit-Token')||'';
      if(!env.EDIT_TOKEN || t!==env.EDIT_TOKEN) return json({error:'unauthorized'},401,c);
      if(req.method==='GET'){ const raw = await env.CACHE.get(KEY);
        return new Response(raw || JSON.stringify({items:[]}),{headers:{...c,'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}}); }
      if(req.method==='PUT'){ const body = await req.text();
        if(body.length>MAX_BYTES) return json({error:'too_large'},413,c);
        let p; try{ p=JSON.parse(body); }catch{ return json({error:'invalid_json'},400,c); }
        if(!valid(p)) return json({error:'invalid_shape'},400,c);
        await env.CACHE.put(KEY, body); return json({ok:true,count:p.items.length},200,c); }
      return json({error:'method_not_allowed'},405,c);
    }
    if(url.pathname==='/'||url.pathname==='/api/health') return json({ok:true,service:'article-search-api'},200,c);
    return new Response('Not Found',{status:404,headers:c});
  },
};
