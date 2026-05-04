# Feature Inventory

Clean rebuild에서 **아직 재구현/유지 판단이 남은 기능성 요소만** 정리한 문서입니다.
이미 재구현 완료된 항목은 이 파일에서 제거했습니다.

- 기준: 2026-04-27 현재 clean rebuild 진행 상태
- 포함: 남은 extension, tool, command, skill, prompt, 주요 후보
- 제외: 이미 재구현 완료되어 남은 후보가 아닌 항목

---

## 1. 한눈에 보는 요약

### 남은 기능 단위 집계

- 남은 custom extension 엔트리포인트: **5개**
- 남은 custom slash command: **2개**
- 남은 custom tool: **7개**
- 남은 로컬 skill 후보: **41개**
- 남은 prompt alias 후보: **8개**

### 핵심 분류

1. **검색/코드 인덱싱 계층**
   - `grep`, `rg`, `find`, `fuzzy_search`, `multi_grep`
   - `project_map`
   - `code_search`, `/reindex`
2. **Git/리뷰/워크플로우 계층**
   - `/update-skills`
3. **대형 skill/prompt pack 계층**
   - gstack 계열
   - visual-explainer 계열
   - browser / QA / design / review / shipping / safety skill 다수

---

## 2. 남은 custom extension 후보

### A. 안전장치 / 컨텍스트 제어

- `agent/extensions/ignore-specific-context-files.ts`
  - 특정 외부 경로의 `AGENTS.md`가 system prompt context로 들어오는 것을 제거
  - 기존 하드코딩 대상:
    - `/Users/charles/Desktop/src/lemonbase/app/AGENTS.md`
  - 재구현 시에는 하드코딩보다 범용 context filter 패턴으로 바꾸는 편이 좋음

### B. 검색 / 인덱싱 / 코드 탐색

- `agent/extensions/fff-search.ts`
  - FFF 기반 고속 검색 계층
  - 제공 tool 후보:
    - `grep`
    - `rg`
    - `find`
    - `fuzzy_search`
    - `multi_grep`
  - 남은 범위는 주로 **내용 검색/멀티 검색 계층**

- `agent/extensions/code-index.ts`
  - 기존 ctags 기반 인덱스 중 `project_map`만 남은 후보로 봄
  - 제공 tool 후보:
    - `project_map`

- `agent/extensions/code-search/index.ts`
  - Python 벡터 검색 엔진을 띄워 semantic code search 제공
  - 제공 tool 후보:
    - `code_search`
  - 제공 command 후보:
    - `/reindex`
  - 내부 엔진 후보:
    - `agent/extensions/code-search/engine/chunker.py`
    - `agent/extensions/code-search/engine/config.py`
    - `agent/extensions/code-search/engine/indexer.py`
    - `agent/extensions/code-search/engine/search.py`
    - `agent/extensions/code-search/engine/server.py`

### C. Git / 리뷰 / 협업 워크플로우

- `agent/extensions/update-skills.ts`
  - `/update-skills`
  - `gst-sync.sh`, `vi-sync.sh`를 실행해 skill/prompt 리소스를 동기화한 뒤 reload

---

## 3. 남은 custom command 후보

| Command | 기존 파일 | 기능 |
|---|---|---|
| `/reindex` | `agent/extensions/code-search/index.ts` | vector code index 재생성 |
| `/update-skills` | `agent/extensions/update-skills.ts` | gst/vi skill 동기화 후 reload |

---

## 4. 남은 custom tool 후보

| Tool | 기존 파일 | 기능 |
|---|---|---|
| `grep` | `agent/extensions/fff-search.ts` | FFF 기반 내용 검색 |
| `rg` | `agent/extensions/fff-search.ts` | `grep` 별칭 |
| `find` | `agent/extensions/fff-search.ts` | FFF 기반 파일 찾기 계층 |
| `fuzzy_search` | `agent/extensions/fff-search.ts` | 파일/내용 통합 fuzzy 검색 |
| `multi_grep` | `agent/extensions/fff-search.ts` | 여러 패턴 OR 검색 |
| `project_map` | `agent/extensions/code-index.ts` | 디렉토리+심볼 구조 요약 |
| `code_search` | `agent/extensions/code-search/index.ts` | semantic vector code search |

---

## 5. 남은 로컬 skill 후보

### A. 브라우저 / 웹 자동화 / 사이트 상호작용

- `agent/skills/agent-browser` — 브라우저 자동화 CLI
- `agent/skills/dogfood` — 웹앱 탐색 테스트 및 이슈 리포트
- `agent/skills/gst-browse` — 빠른 headless 브라우저 QA
- `agent/skills/gst-connect-chrome` — 가시적인 GStack Browser 실행
- `agent/skills/gst-open-gstack-browser` — GStack Browser 실행(기능상 매우 유사)
- `agent/skills/gst-pair-agent` — 원격 AI agent에게 브라우저 세션 공유
- `agent/skills/gst-setup-browser-cookies` — 실제 브라우저 쿠키를 headless 세션에 주입

### B. 계획 / 리뷰 / 분석 / 품질 평가

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

### C. 디자인 / 프론트엔드 / 시각화

- `agent/skills/frontend-skills` — 미적으로 강한 landing/app UI 설계 지침
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

## 6. 남은 prompt alias 후보

모두 `agent/prompts/` 아래에 있던 visual-explainer 관련 alias입니다.

- `vi-diff-review.md`
- `vi-fact-check.md`
- `vi-generate-slides.md`
- `vi-generate-visual-plan.md`
- `vi-generate-web-diagram.md`
- `vi-plan-review.md`
- `vi-project-recap.md`
- `vi-share.md`

---

## 7. 중복 / 겹침 / 선택 포인트

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
  - prompt alias 세트가 visual-explainer workflow 노출 창구 역할

### 로컬 특수 예외 처리

- `ignore-specific-context-files.ts`
  - 특정 로컬 경로를 하드코딩해서 context에서 제거
  - 재구현한다면 범용 pattern 기반 필터가 더 적합

### 강한 정책성 기능

- 현재 남은 후보 없음

---

## 8. 비기능성 파일 / 캐시 / 참고용 디렉토리

아래는 남은 후보와 관련된 캐시/산출물/보조 자원입니다.

### 캐시 / 생성물

- `.pi/index/tags.jsonl` — 기존 ctags/code-index 캐시
- `.ruff_cache/` — Python lint cache

### dependency / build metadata 후보

- `agent/extensions/package-lock.json`
- `agent/extensions/package.json`

### 현재 비어 있거나 기능성이 낮은 디렉토리

- `config/` — 비어 있음
- `agent/git/` — 현재 실질 콘텐츠 거의 없음
- `agent/skills/deep-interview/` — 디렉토리는 있으나 `SKILL.md` 없음 (기존 기준 비활성/미완성으로 보임)

---

## 9. 다음 구현 후보 추천

1. **`project_map`**
   - LSP symbol search와 보완 관계
2. **내용 검색 도구 (`grep`/`rg`/`multi_grep`)**
   - built-in bash/rg보다 짧고 구조화된 검색 결과 제공
3. **`/update-skills`**
   - skill/prompt 리소스 동기화 workflow
---

## 10. 재구현/제거 판단용 분류 프레임

1. **핵심 기반 기능**
   - `fff-search`, `project_map`, `code_search`
2. **세션/UX 편의 기능**
   - 현재 남은 후보 없음
3. **정책 기능**
   - `ignore-specific-context-files`
4. **Git/협업 자동화 기능**
   - `/update-skills`
5. **대형 skill/prompt pack**
   - `agent/skills/*`
   - `agent/prompts/*`
