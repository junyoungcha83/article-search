# 기사검색

키워드로 최신 기사를 찾아 **언론사별로 비교**해 주고, 기사 링크를 붙여넣으면 **제목·핵심 내용**을 요약해 주는
가족용 PWA. 백엔드 없이 브라우저에서 Claude API를 직접 호출한다.

```
├─ 🔎 검색 및 분석
│   └─ 검색어 입력 → 핵심 내용 / 언론사별 비교 / 공통 팩트 / 초등학생이 이해하기 쉬운 설명
├─ 🔎 기사요약
│   └─ 링크 붙이기 → 제목·핵심 내용 요약 / 관련 기사 링크(참고용)
└─ ℹ️ 정보
    └─ 지금 쓰는 모델 / 1회 검색당 비용(실측) / 사용방법
```

## 구조

| 파일 | 역할 |
|---|---|
| `index.html` | 화면 뼈대(탭 2개 + 설정 시트) |
| `assets/app.js` | Claude API 호출, 프롬프트, 결과 렌더링, 캐시 |
| `assets/app.css` | 스타일 (브리핑앱과 같은 팔레트) |
| `sw.js` | 앱 셸 오프라인 캐시 — API 호출은 가로채지 않음 |

정적 파일뿐이라 GitHub Pages에 그대로 올라간다. 빌드 단계 없음.

## 동작 방식

- **검색 및 분석** — Claude의 서버측 `web_search` 도구로 여러 언론사 기사를 모은 뒤 JSON 스키마
  (`core` / `outlets` / `common_facts` / `kid` / `sources`)로 정리해 화면에 뿌린다.
- **기사요약** — `web_fetch` 로 붙여넣은 링크의 본문을 읽고, `web_search` 로 관련 기사를 찾는다.
- 프롬프트에 **추측·예측·창작 금지**, 숫자·날짜는 기사 그대로, 확인 못한 건 `note` 에 적기를 못박아 뒀다.
- 같은 검색어/링크는 **6시간 동안 로컬 캐시**에서 꺼내 쓴다(요금 절약). ⚙︎ 에서 비울 수 있다.
- **정보 탭**은 API 응답의 `usage`(입력·출력 토큰, 웹검색 횟수)를 기기에 쌓아 두고 공식 단가로
  실제 비용을 계산해 보여준다. 기록이 없으면 대략치를 보여주고, 한 번 쓰면 실측으로 바뀐다.

### 모델별 지원 차이 (중요)

모델마다 쓸 수 있는 옵션이 달라 `toolsFor()` / `useEffort()` 에서 분기한다.

| | Opus 5 · Sonnet 5 | Haiku 4.5 |
|---|---|---|
| `output_config.effort` | 지원 | 미지원 |
| 웹검색·웹읽기 도구 | `_20260209` (코드실행 기반 필터링) | `web_search_20250305` · `web_fetch_20250910` |

그래도 400 이 오면 해당 옵션을 빼고 **자동 재시도**하며 그 모델을 localStorage 에 기억한다
(`as-no-effort`, `as-basic-tools`) — 화면에는 오류가 보이지 않는다.

## API 키

첫 실행 때 ⚙︎ 설정이 열린다. [console.anthropic.com](https://console.anthropic.com/settings/keys) 에서
발급한 키를 넣으면 **이 기기의 localStorage** 에만 저장되고, 요청은 브라우저에서 `api.anthropic.com` 으로
바로 나간다(`anthropic-dangerous-direct-browser-access` 헤더 사용).

- 공용·공유 기기에서는 쓰지 말 것.
- 키는 필요할 때 폐기·재발급할 수 있게 이 앱 전용으로 하나 만들어 두는 편이 안전하다.
- 검색 1회 비용 ≈ 웹검색 $0.01 + 토큰 요금. 자주 쓰면 설정에서 모델을 Sonnet/Haiku로 낮추면 된다.

## 로컬 실행

```bash
cd ~/Documents/github/article-search
python3 -m http.server 8890
# → http://localhost:8890
```
