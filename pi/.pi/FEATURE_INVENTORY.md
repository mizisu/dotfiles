# Feature Inventory

현재 디렉토리(`.pi`)에 들어있는 **실제 기능성 요소만** 정리한 문서입니다.

- 기준: 2026-04-23 현재 파일 상태
- 포함: 커스텀 extension, tool, command, skill, prompt, theme, 주요 설정
- 제외: `package-lock.json`, 캐시, 생성 산출물, 빈 디렉토리 같은 비기능 파일은 별도 섹션으로 분리

---

## 1. 한눈에 보는 요약

### 기능 단위 집계

- 커스텀 extension 엔트리포인트: **22개**
- 커스텀 slash command: **10개**
- 커스텀 tool: **16개**
- 로컬 skill: **44개**
- 로컬 prompt alias: **8개**
- 로컬 theme: **1개**

### 핵심 분류

1. **검색/코드 인덱싱 계층**
   - `grep`, `rg`, `find`, `fuzzy_search`, `multi_grep`
   - `search_symbols`, `project_map`, `code_search`, `/reindex`
   - `goto_definition`, `find_references`, `get_diagnostics`, `hover_info`, `/lsp-status`
2. **Git/리뷰/워크플로우 계층**
   - `/commit`, `/pr`, `/cr-review`, `/btw`, `/mcp`, `/update-skills`
3. **UI/세션 UX 계층**
   - 자동 세션 제목, footer, startup brand, mermaid ASCII 렌더링, 파일 picker, thinking level selector
4. **안전장치 계층**
   - `.env` / `agent/auth.json` 접근 차단
   - 특정 외부 `AGENTS.md` context 주입 제거
5. **대형 skill pack 계층**
   - gstack 계열 다수
   - visual-explainer 계열
   - browser / QA / design / review / shipping / safety skill 다수

---

## 2. 주요 설정 파일

### `agent/settings.json`

현재 동작에 직접 영향을 주는 설정:

- 기본 provider/model
  - `defaultProvider`: `openai-codex`
  - `defaultModel`: `gpt-5.5`
  - `mediumModel`: `gpt-5.3-codex-spark`
  - `smallModel`: `gpt-5.4-mini`
- 기본 thinking level: `xhigh`
- theme: `catppuccin-macchiato`
- terminal 이미지 표시: `true`
- compaction: `enabled`
- startup 조용하게 시작: `quietStartup: true`
- install telemetry 비활성화
- 외부 packages 참조:
  - `https://github.com/davebcn87/pi-autoresearch`

### `agent/APPEND_SYSTEM.md`

에이전트의 기본 작업 원칙을 덧붙이는 시스템 규칙 파일입니다.
기능 추가라기보다 **행동 정책**입니다.

---

## 3. 커스텀 extension 전체 목록

> 아래는 **실제 동작을 추가하는 extension 엔트리포인트**입니다.
> `agent/extensions/shared/*`, `lsp/client.ts`, `lsp/servers.ts` 같은 내부 helper는 별도 구현 지원 파일로 보고 여기선 보조 설명만 붙였습니다.

### A. 안전장치 / 컨텍스트 제어

- `agent/extensions/block-env-read.ts`
  - `.env`, `.env.example`, `agent/auth.json`에 대한 `read`/`write`/`edit` 차단
  - bash 명령으로 민감 파일을 건드리는 것도 차단

- `agent/extensions/ignore-specific-context-files.ts`
  - 특정 외부 경로의 `AGENTS.md`가 system prompt context로 들어오는 것을 제거
  - 현재 하드코딩된 대상:
    - `/Users/charles/Desktop/src/lemonbase/app/AGENTS.md`
  - 매우 프로젝트 특화된 예외 처리

### B. 검색 / 인덱싱 / 코드 탐색

- `agent/extensions/fff-search.ts`
  - FFF 기반 고속 검색 계층 추가
  - 제공 tool:
    - `grep`
    - `rg`
    - `find`
    - `fuzzy_search`
    - `multi_grep`
  - 기존 shell 검색보다 빠르고, 제약 조건/커서/안전한 범위 처리 지원

- `agent/extensions/code-index.ts`
  - ctags 기반 심볼 인덱스 생성/캐시
  - 제공 tool:
    - `search_symbols`
    - `project_map`
  - Git HEAD 변화를 감시해서 인덱스 stale 여부 판단

- `agent/extensions/code-search/index.ts`
  - Python 벡터 검색 엔진을 띄워 semantic code search 제공
  - 제공 tool:
    - `code_search`
  - 제공 command:
    - `/reindex`
  - 내부 엔진 파일:
    - `agent/extensions/code-search/engine/chunker.py`
    - `.../config.py`
    - `.../indexer.py`
    - `.../search.py`
    - `.../server.py`

- `agent/extensions/lsp/index.ts`
  - LSP 서버 자동 탐지/기동/진단/정의 탐색 계층
  - 제공 tool:
    - `goto_definition`
    - `find_references`
    - `get_diagnostics`
    - `hover_info`
  - 제공 command:
    - `/lsp-status`
  - 내부 구현 보조:
    - `agent/extensions/lsp/client.ts`
    - `agent/extensions/lsp/servers.ts`

### C. Git / 리뷰 / 협업 워크플로우

- `agent/extensions/commit.ts`
  - `/commit`
  - 변경사항을 문맥별로 나눠 smart commit 수행
  - isolated context 기반 커밋 작성 흐름

- `agent/extensions/pr.ts`
  - `/pr`
  - fuzzy branch picker를 써서 GitHub PR 생성
  - isolated context 기반 PR 작성 흐름

- `agent/extensions/cr-review.ts`
  - `/cr-review`
  - CodeRabbit review를 파싱하고, 선택적으로 suggestion 적용

- `agent/extensions/btw.ts`
  - `/btw`
  - 메인 작업을 막지 않고 concurrent side question 실행
  - 인자 없이 실행하면 기존 side thread review UI 오픈

- `agent/extensions/mcporter/index.ts`
  - `/mcp`
  - `mcp` tool을 세션 단위로 on/off/status/refresh 관리
  - 제공 tool:
    - `mcp`
  - mcporter runtime을 통해 MCP server discovery / tool describe / tool call 수행

- `agent/extensions/update-skills.ts`
  - `/update-skills`
  - `gst-sync.sh`, `vi-sync.sh`를 실행해 skill/prompt 리소스를 동기화한 뒤 reload

### D. 사용자 질문 / 웹 도구

- `agent/extensions/question.ts`
  - 제공 tool:
    - `question`
  - 짧은 옵션 기반 사용자 질문 UI

- `agent/extensions/web-fetch-search.ts`
  - 제공 tool:
    - `web_fetch`
    - `web_search`
  - `web_fetch`: URL 내용을 Markdown으로 가져옴
  - `web_search`: DuckDuckGo/Brave/Jina 계열 웹 검색

### E. 세션 UX / 에디터 UX / 표시 개선

- `agent/extensions/fzf-file-picker.ts`
  - `@` shortcut 및 `/files`
  - 전체 화면 fuzzy file/folder picker
  - 선택 결과를 `@path` 형태로 에디터에 삽입

- `agent/extensions/cursor-aware-triggers.ts`
  - `@`, `#` 입력 시 커서 위치를 보고 picker shortcut을 열지 여부 결정
  - 줄 시작/공백 뒤에서만 확장 동작

- `agent/extensions/effort.ts`
  - `/effort`
  - thinking level을 `off/mid/max` 등으로 빠르게 전환

- `agent/extensions/session-auto-name.ts`
  - 첫 사용자 메시지를 바탕으로 세션 제목 자동 생성
  - small model slot 사용

- `agent/extensions/footer.ts`
  - footer를 커스텀 렌더링
  - 표시 항목:
    - 세션 이름
    - 현재 경로 + git branch
    - 토큰 사용량
    - cache read/write
    - 비용
    - context usage bar
    - plan usage(Anthropic rate-limit header 기반)
    - 모델명 / thinking level
    - extension status line

- `agent/extensions/startup-brand.ts`
  - startup/reload 시 Pi ASCII logo header 표시
  - agent 시작 직전에 header 제거

- `agent/extensions/mermaid/index.ts`
  - Markdown 내 `mermaid` code block을 폭이 허용되면 ASCII 다이어그램으로 inline 렌더링
  - resume history 렌더링 시 예외 처리 포함

- `agent/extensions/compactions.ts`
  - 세션 compact 시 medium model slot을 사용한 custom compaction 수행
  - 실패 시 기본 compaction으로 복귀

---

## 4. 커스텀 command 목록

| Command | 파일 | 기능 |
|---|---|---|
| `/btw` | `agent/extensions/btw.ts` | 메인 작업과 병렬로 side question 실행 |
| `/reindex` | `agent/extensions/code-search/index.ts` | ctags + vector code index 재생성 |
| `/commit` | `agent/extensions/commit.ts` | smart commit |
| `/cr-review` | `agent/extensions/cr-review.ts` | CodeRabbit suggestion review/apply |
| `/effort` | `agent/extensions/effort.ts` | thinking level 전환 |
| `/files` | `agent/extensions/fzf-file-picker.ts` | 파일 picker 오픈 |
| `/lsp-status` | `agent/extensions/lsp/index.ts` | LSP 서버 상태 확인 |
| `/mcp` | `agent/extensions/mcporter/index.ts` | mcp tool 세션 제어 |
| `/pr` | `agent/extensions/pr.ts` | GitHub PR 생성 |
| `/update-skills` | `agent/extensions/update-skills.ts` | gst/vi skill 동기화 후 reload |

---

## 5. 커스텀 tool 목록

| Tool | 파일 | 기능 |
|---|---|---|
| `grep` | `agent/extensions/fff-search.ts` | FFF 기반 내용 검색 |
| `rg` | `agent/extensions/fff-search.ts` | `grep` 별칭 |
| `find` | `agent/extensions/fff-search.ts` | FFF 기반 파일 찾기 |
| `fuzzy_search` | `agent/extensions/fff-search.ts` | 파일/내용 통합 fuzzy 검색 |
| `multi_grep` | `agent/extensions/fff-search.ts` | 여러 패턴 OR 검색 |
| `search_symbols` | `agent/extensions/code-index.ts` | 심볼 검색 |
| `project_map` | `agent/extensions/code-index.ts` | 디렉토리+심볼 구조 요약 |
| `code_search` | `agent/extensions/code-search/index.ts` | semantic vector code search |
| `goto_definition` | `agent/extensions/lsp/index.ts` | 정의로 이동 |
| `find_references` | `agent/extensions/lsp/index.ts` | 참조 찾기 |
| `get_diagnostics` | `agent/extensions/lsp/index.ts` | 타입/린트 진단 조회 |
| `hover_info` | `agent/extensions/lsp/index.ts` | hover type/documentation 조회 |
| `question` | `agent/extensions/question.ts` | 옵션형 사용자 질문 UI |
| `web_fetch` | `agent/extensions/web-fetch-search.ts` | URL fetch + Markdown 변환 |
| `web_search` | `agent/extensions/web-fetch-search.ts` | 최신 웹 검색 |
| `mcp` | `agent/extensions/mcporter/index.ts` | mcporter-backed MCP 접근 |

---

## 6. 로컬 skill 전체 목록 (44개)

### A. 브라우저 / 웹 자동화 / 사이트 상호작용

- `agent/skills/agent-browser` — 브라우저 자동화 CLI
- `agent/skills/dogfood` — 웹앱 탐색 테스트 및 이슈 리포트
- `agent/skills/gst-browse` — 빠른 headless 브라우저 QA
- `agent/skills/gst-connect-chrome` — 가시적인 GStack Browser 실행
- `agent/skills/gst-open-gstack-browser` — GStack Browser 실행(기능상 매우 유사)
- `agent/skills/gst-pair-agent` — 원격 AI agent에게 브라우저 세션 공유
- `agent/skills/gst-setup-browser-cookies` — 실제 브라우저 쿠키를 headless 세션에 주입

### B. 계획 / 리뷰 / 분석 / 품질 평가

- `agent/skills/first-principles` — 제1원리 기반 문제 분석
- `agent/skills/gst-autoplan` — CEO/Design/Eng/DX review 자동 연쇄 실행
- `agent/skills/gst-cso` — 보안 감사 / 위협 모델링 / 공급망 점검
- `agent/skills/gst-devex-review` — 실제 DX 흐름 체험형 감사
- `agent/skills/gst-design-review` — 구현된 UI의 디자인 QA 및 수정
- `agent/skills/gst-health` — 타입/린트/테스트 등을 합친 코드 건강 점수화
- `agent/skills/gst-investigate` — 원인 분석 중심 디버깅 프로세스
- `agent/skills/gst-plan-ceo-review` — CEO/founder 관점의 scope/ambition 리뷰
- `agent/skills/gst-plan-design-review` — 디자인 계획 리뷰
- `agent/skills/gst-plan-devex-review` — 개발자 경험 계획 리뷰
- `agent/skills/gst-plan-eng-review` — 엔지니어링 계획 리뷰
- `agent/skills/gst-retro` — 주간 엔지니어링 회고
- `agent/skills/gst-review` — pre-landing PR review
- `agent/skills/simplicity-guard` — 과설계/불필요한 복잡성 감지

### C. 디자인 / 프론트엔드 / 시각화

- `agent/skills/frontend-skills` — 미적으로 강한 landing/app UI 설계 지침
- `agent/skills/frontend-style` — 프론트엔드 코딩 컨벤션
- `agent/skills/gst-design-consultation` — 디자인 시스템/브랜드 방향 정의
- `agent/skills/gst-design-html` — 승인된 디자인을 production-quality HTML/CSS로 구현
- `agent/skills/gst-design-shotgun` — 여러 디자인 시안 생성 및 비교
- `agent/skills/visual-explainer` — 시스템/계획/변경사항을 HTML 시각자료로 설명

### D. QA / 성능 / 배포 / 릴리즈

- `agent/skills/gst-benchmark` — 성능 회귀 측정
- `agent/skills/gst-canary` — 배포 후 canary 모니터링
- `agent/skills/gst-document-release` — 배포 후 문서/README/CHANGELOG 동기화
- `agent/skills/gst-land-and-deploy` — merge 후 deploy + live verify
- `agent/skills/gst-qa` — QA 후 버그 수정까지 포함한 루프
- `agent/skills/gst-qa-only` — QA report only
- `agent/skills/gst-setup-deploy` — deploy 설정 자동화
- `agent/skills/gst-ship` — 테스트/버전/체인지로그/PR 생성까지 ship workflow

### E. 안전 / 범위 제한 / 세션 상태 관리

- `agent/skills/gst-careful` — 파괴적 명령 전 경고
- `agent/skills/gst-checkpoint` — 작업 상태 checkpoint / resume
- `agent/skills/gst-freeze` — 특정 디렉토리 밖 편집 차단
- `agent/skills/gst-guard` — careful + freeze 결합
- `agent/skills/gst-learn` — 세션 간 학습/패턴 관리
- `agent/skills/gst-unfreeze` — freeze 해제
- `agent/skills/gst-upgrade` — gstack 업그레이드

### F. 브레인스토밍 / 외부 AI 보조 / 의사결정

- `agent/skills/gst-codex` — Codex second opinion / review / consult
- `agent/skills/gst-office-hours` — 아이디어 브레인스토밍 / YC 스타일 forcing questions

---

## 7. 로컬 prompt alias 목록 (8개)

모두 `agent/prompts/` 아래에 있으며, 사실상 **visual-explainer 관련 alias** 성격이 강합니다.

- `vi-diff-review.md`
- `vi-fact-check.md`
- `vi-generate-slides.md`
- `vi-generate-visual-plan.md`
- `vi-generate-web-diagram.md`
- `vi-plan-review.md`
- `vi-project-recap.md`
- `vi-share.md`

---

## 8. Theme

- `agent/themes/catppuccin-macchiato.json`
  - 현재 `agent/settings.json`에서 기본 theme로 사용 중

---

## 9. 중복 / 겹침 / 선택 포인트가 될 가능성이 큰 항목

이 섹션은 삭제 권고가 아니라, **나중에 재구현/제거 선택 시 먼저 비교해볼 만한 묶음**입니다.

### 거의 같은 역할이 보이는 쌍

- `gst-connect-chrome` ↔ `gst-open-gstack-browser`
  - 둘 다 GStack Browser 실행 계열
- `gst-qa` ↔ `gst-qa-only`
  - QA 도메인은 같고, fix 포함 여부만 다름
- `gst-design-review` ↔ `gst-plan-design-review`
  - 하나는 live implementation review, 다른 하나는 plan review
- `agent-browser` ↔ `gst-browse`
  - 둘 다 브라우저 자동화/상호작용 계열

### 기능-별칭 관계가 강한 묶음

- `visual-explainer` skill ↔ `agent/prompts/vi-*`
  - prompt alias 세트가 사실상 visual-explainer workflow 노출 창구 역할

### 로컬 특수 예외 처리

- `ignore-specific-context-files.ts`
  - 특정 로컬 경로를 하드코딩해서 context에서 제거
  - 범용 기능보다는 환경 특화 커스텀

### 강한 정책성 기능

- `block-env-read.ts`
  - 민감 파일 접근 차단 정책
- `compactions.ts`
  - compact 모델 선택 정책
- `session-auto-name.ts`
  - 자동 세션 네이밍 정책
- `footer.ts`
  - UI footer 정책

---

## 10. 비기능성 파일 / 캐시 / 참고용 디렉토리

아래는 기능 그 자체보다는 캐시/산출물/보조 자원입니다.

### 캐시 / 생성물

- `.pi/index/tags.jsonl` — 코드 인덱스 캐시
- `.ruff_cache/` — Python lint cache
- `agent/mcporter-cache.json` — MCP 메타데이터 캐시

### dependency / build metadata

- `agent/extensions/package-lock.json`
- `agent/extensions/lsp/package-lock.json`
- `agent/extensions/mcporter/package-lock.json`
- `agent/extensions/mermaid/package-lock.json`

### 보조 패키지 파일

- `agent/extensions/lsp/package.json`
- `agent/extensions/mcporter/package.json`
- `agent/extensions/mermaid/package.json`
- `agent/extensions/package.json`

### 현재 비어 있거나 기능성이 낮은 디렉토리

- `config/` — 비어 있음
- `agent/git/` — 현재 실질 콘텐츠 거의 없음
- `agent/skills/deep-interview/` — 디렉토리는 있으나 `SKILL.md` 없음 (현재 기준 비활성/미완성으로 보임)

---

## 11. 재구현/제거 판단용 추천 분류 프레임

나중에 고를 때는 아래 5묶음으로 보면 가장 정리가 쉽습니다.

1. **핵심 기반 기능**
   - `fff-search`, `code-index`, `code-search`, `lsp`
2. **세션/UX 편의 기능**
   - `session-auto-name`, `footer`, `startup-brand`, `mermaid`, `files`, `effort`, `cursor-aware-triggers`
3. **정책/안전 기능**
   - `block-env-read`, `ignore-specific-context-files`, `compactions`
4. **Git/협업 자동화 기능**
   - `commit`, `pr`, `cr-review`, `btw`, `mcp`, `update-skills`
5. **대형 skill pack / prompt pack**
   - `agent/skills/*`
   - `agent/prompts/*`

이렇게 보면 나중에 다음 질문이 쉬워집니다:

- 정말 필요한 **핵심 도구**만 남길지
- UI/편의 기능을 어디까지 유지할지
- gstack/visual-explainer 같은 **대형 skill pack**을 통째로 유지할지
- 로컬 특화 예외(`ignore-specific-context-files`)를 제거할지

---

## 12. 다음 단계 제안

이 문서를 기준으로 다음 중 하나를 선택하면 됩니다.

1. **유지 / 재구현 / 제거 3분류표 만들기**
2. **extension만 추려서 1차 정리하기**
3. **skills만 추려서 1차 정리하기**
4. **중복 기능끼리 비교표 만들기**
5. **완전 초기화 기준안(minimal baseline) 만들기**
