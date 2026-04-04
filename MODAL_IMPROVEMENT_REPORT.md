# NodeDetailModal 심층 분석 및 개선 계획

## 1. 현황 분석

### 1.1 현재 모달의 사용자 여정

```
더블클릭 → 모달 열림 → 좌측: 노드 정보 / 우측: 3D 서브그래프
                              ↓
                     연결 항목(Author/Repo/Topic) 클릭
                              ↓
                     ❌ 모달 닫힘 → 메인 그래프로 돌아감
                     (탐색 흐름이 끊김)
```

### 1.2 핵심 문제점

#### Problem 1: 연결 노드 클릭 시 모달이 닫힘
- 좌측 패널에서 Author, Repo, Topic을 클릭하면 **모달이 닫히고 메인 그래프로 이동**
- 사용자가 관계를 따라가며 탐색하고 싶지만, 매번 모달이 닫혀서 **탐색 흐름이 끊김**
- 다시 탐색하려면 메인 그래프에서 해당 노드를 찾아 더블클릭해야 함

#### Problem 2: 연결 노드 정보가 빈약함
- 연결된 Author: **로그인 ID만 표시** (이름, 아바타, bio, followers 없음)
- 연결된 Repo: **축약된 이름 + val 값만 표시** (stars, language, description 없음)
- 연결된 Topic: **이름만 표시** (연관 레포 수 없음)

#### Problem 3: 관계 깊이가 얕음
- 1-hop 직접 연결만 표시 (저자, 레포, 토픽 목록)
- **기여자(Contributors) 정보 없음** — 누가 얼마나 기여했는지
- **저자의 다른 레포 정보 없음** — 같은 저자의 다른 프로젝트가 뭔지
- **공통 기여자(Coworker) 관계 없음** — 어떤 개발자들이 함께 작업하는지
- **Fork 관계 없음** — 어떤 레포에서 포크되었는지, 주요 포크는 뭔지

#### Problem 4: 서브그래프와 정보 패널이 분리됨
- 우측 3D 서브그래프에서 노드를 클릭해도 좌측 정보 패널이 업데이트되지 않음
- 서브그래프 내 노드 탐색과 정보 확인이 별개로 작동

---

## 2. DB에서 가용한 데이터 (현재 미활용)

### 2.1 RepoContributor 테이블
```
repository_id, author_id, contributions (기여 횟수)
```
- 레포별 상위 기여자 목록과 기여도를 보여줄 수 있음
- 현재 그래프 엣지 생성에만 사용, 모달에서는 미표시

### 2.2 Author → Repository 관계 (owner_id)
```
Repository.owner_id → Author.id
```
- 특정 저자가 소유한 모든 레포를 조회할 수 있음
- 현재 모달에서는 단순 연결 목록만 표시

### 2.3 Fork 관계
```
Repository.fork_source_id → Repository.id
```
- 포크 원본과 파생 레포 관계를 추적할 수 있음
- 현재 is_fork 불리언만 표시, 원본/포크 체인은 미표시

### 2.4 Graph Builder의 Link Types
```
owns, contributes, has_topic, forked_from, coworker
```
- 엣지 타입별로 필터링하면 관계의 성격을 구분할 수 있음
- 현재 모달에서는 엣지 타입 정보를 활용하지 않음

---

## 3. 개선 방향

### 3.1 모달 내 네비게이션 (In-Modal Navigation)

**현재:** 연결 클릭 → 모달 닫힘 → 메인 그래프 이동
**개선:** 연결 클릭 → **모달 내에서 해당 노드로 전환** (히스토리 스택)

```
[langgenius/dify] → 클릭: SonAIengine → [SonAIengine 상세] → 뒤로가기 → [langgenius/dify]
```

- 모달 내 **뒤로가기/앞으로가기** 네비게이션
- 탐색 히스토리 스택 유지 (브라우저처럼)
- 모달을 닫지 않고도 연결 관계를 따라 깊이 탐색 가능

### 3.2 연결 노드 상세 정보 (Enriched Connections)

**현재:** `SonAIengine` (텍스트만)
**개선:**

```
┌──────────────────────────────────────┐
│ 👤 SonAIengine                       │
│    홍길동 · 150 followers · 42 repos │
│    "AI researcher at KU"             │
└──────────────────────────────────────┘
```

- Author 연결: 아바타 + 이름 + followers + bio 미리보기
- Repo 연결: stars + language + description 미리보기
- Topic 연결: 연관 레포 수

**구현:** Backend API를 확장하여 `/api/graph/node/{id}` 응답에 **enriched connections** 포함

### 3.3 새로운 정보 섹션 추가

#### A. Contributors 섹션 (Repo 노드)
```
TOP CONTRIBUTORS                    5
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 torvalds        2,847 contributions
👤 gregkh          1,523 contributions  
👤 rostedt           891 contributions
```

#### B. Owner's Other Repos 섹션 (Repo 노드)
```
MORE FROM langgenius                 8
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 dify-sandbox       ★ 2,341  Python
📦 dify-docs          ★ 1,102  MDX
📦 dify-plugins       ★ 856    TypeScript
```

#### C. Top Repositories 섹션 (Author 노드)
```
TOP REPOSITORIES                    12
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 ku-portal-mcp    ★ 10   Python
📦 ai-assistant     ★ 5    TypeScript
```

#### D. Related Topics 섹션 (Repo 노드)
현재도 있지만, 각 토픽의 인기도(repo_count)를 함께 표시

#### E. Fork Chain 섹션 (Fork된 Repo)
```
FORK CHAIN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 original/repo  ★ 45,231  (원본)
  └─ 📦 fork/repo  ★ 123    (현재)
```

### 3.4 서브그래프 ↔ 정보 패널 연동

- 서브그래프에서 노드를 클릭하면 좌측 패널에 **해당 노드의 요약 정보** 표시
- 서브그래프에서 노드를 더블클릭하면 **모달 내에서 해당 노드로 네비게이션**
- 좌측 연결 목록의 항목 위에 마우스를 올리면 서브그래프에서 해당 노드 하이라이트

---

## 4. 구현 계획

### Phase 1: 모달 내 네비게이션 시스템
- **작업:** NodeDetailModal에 히스토리 스택 추가
- **상세:**
  - `navigationStack` state: `[{nodeId, nodeData}]`
  - 뒤로/앞으로 버튼을 모달 헤더에 추가
  - 연결 항목 클릭 시 현재 노드를 스택에 push하고 새 노드로 전환
  - 새 노드의 상세 정보를 API에서 fetch
  - 서브그래프도 새 노드 중심으로 재생성
- **변경 파일:**
  - `NodeDetailModal.jsx` — 네비게이션 로직 + UI
  - `GraphPage.jsx` — onNodeNavigate 콜백 수정

### Phase 2: Backend API 확장 (Enriched Node Detail)
- **작업:** `/api/graph/node/{id}` 응답에 관계 데이터 포함
- **상세:**
  - Repo 노드: + contributors (상위 10명, 기여수 포함) + owner 상세 + 같은 owner의 다른 레포
  - Author 노드: + 소유 레포 (상위 10개) + 기여한 레포 (상위 10개)
  - Topic 노드: + 인기 레포 (상위 5개)
- **변경 파일:**
  - `backend/app/api/routes.py` — 엔드포인트 확장

### Phase 3: 연결 항목 상세 정보 표시
- **작업:** 좌측 패널의 연결 목록을 리치 카드로 교체
- **상세:**
  - Author 카드: 아바타 + 이름 + followers + bio
  - Repo 카드: stars + language + description
  - Topic 카드: repo_count 배지
- **변경 파일:**
  - `NodeDetailModal.jsx` — ConnectionGroup 컴포넌트 리디자인
  - `index.css` — 새 카드 스타일

### Phase 4: 서브그래프-패널 연동
- **작업:** 3D 서브그래프 클릭 시 좌측 패널 업데이트
- **상세:**
  - 서브그래프 싱글클릭 → 좌측에 미니 요약 표시
  - 서브그래프 더블클릭 → 모달 내 네비게이션 (Phase 1 활용)
- **변경 파일:**
  - `NodeDetailModal.jsx` — 이벤트 연결

---

## 5. 구현 우선순위

| 순위 | Phase | 임팩트 | 복잡도 | 설명 |
|------|-------|--------|--------|------|
| 1 | Phase 1 | ★★★★★ | 중 | 모달 내 네비게이션 — UX의 가장 큰 개선 |
| 2 | Phase 2 | ★★★★☆ | 중 | Backend 확장 — Phase 3의 선행 조건 |
| 3 | Phase 3 | ★★★★☆ | 저 | 리치 카드 — 정보 밀도 대폭 증가 |
| 4 | Phase 4 | ★★★☆☆ | 저 | 그래프-패널 연동 — 탐색 경험 완성 |

---

## 6. 기대 효과

### Before (현재)
- 모달에서 연결 클릭 → 모달 닫힘 → 탐색 흐름 단절
- 연결 노드는 이름만 표시 → 어떤 노드인지 판단 어려움
- 레포의 기여자, 저자의 다른 프로젝트 등 심층 정보 없음

### After (개선 후)
- 모달 안에서 자유롭게 네비게이션 → 끊김 없는 탐색
- 연결 노드의 핵심 정보가 즉시 보임 → 빠른 판단
- Contributors, Owner's repos, Fork chain 등 → 네트워크의 숨겨진 관계 발견
- 서브그래프 클릭 → 즉시 정보 확인 → 시각적 탐색과 정보 탐색의 통합
