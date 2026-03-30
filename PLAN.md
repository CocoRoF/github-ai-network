# GitHub AI Network – 개선 계획서 v2

## 현재 상태 분석

### 현재 아키텍처
```
Frontend (React + react-force-graph-2d)
  └─ App.jsx (단일 페이지, 검색/필터/크롤러제어/그래프 모두 포함)
  └─ GraphView.jsx (ForceGraph2D 렌더링)
  └─ Sidebar.jsx (필터, 크롤러 상태, 노드 상세)

Backend (FastAPI)
  └─ routes.py (단일 라우터: /api/graph, /api/search, /api/stats, /api/crawler/*)
  └─ crawler.py (GitHubCrawler: 하드코딩된 AI_SEARCH_QUERIES로 시작)
  └─ graph/builder.py (GraphBuilder: 전체 DB에서 그래프 생성)
  └─ models.py (Author, Repository, Topic, RepoTopic, RepoContributor, CrawlTask)
```

### 현재 수집하는 데이터 & 놓치고 있는 데이터

| 데이터 | 현재 수집 | 활용 | 누락/개선 가능 |
|--------|-----------|------|---------------|
| Repository 기본정보 | ✅ stars, forks, language, license, description | 노드 생성, 크기 결정 | ─ |
| Repository topics | ✅ GitHub topic 태그 | Topic 노드 + has_topic 링크 | ─ |
| Owner (author) | ✅ login, avatar, followers | Author 노드 + owns 링크 | ─ |
| Contributors | ✅ 상위 15명, contribution 수 | contributes 링크 | **contributions 수를 링크 두께에 미반영** |
| Fork 관계 | ✅ fork_source_id 저장 | **미사용** – 그래프에 fork 링크 없음 | **fork 링크 추가 필요** |
| Language | ✅ 메인 언어 1개 | Sidebar 표시만 | **Language 노드로 확장하면 같은 언어 repo 클러스터 가능** |
| User company | ✅ company 필드 | 미사용 | **Organization 노드로 확장하면 같은 회사 개발자 클러스터** |
| Co-worker 관계 | ❌ | ─ | **같은 repo에 기여한 author 쌍 → coworker 링크** |
| Stargazer overlap | ❌ (API 비용 높음) | ─ | 수집 불가 (rate limit) |
| Dependency 관계 | ❌ | ─ | GitHub API에 없음 (별도 파싱 필요, 복잡도 높음) |

### 현재 문제점

| # | 문제 | 상세 |
|---|------|------|
| 1 | **크롤러 시작점이 고정** | `seeds.py`의 하드코딩된 14개 AI 검색어로만 시작. 사용자가 시작점을 지정할 수 없음 |
| 2 | **크롤러 세션 개념 없음** | 모든 CrawlTask가 하나의 풀에 섞임. 어떤 시작점에서 파생된 데이터인지 추적 불가 |
| 3 | **Contributor 관계 불완전** | contributor를 수집은 하지만, contributor의 다른 repo를 재방문하여 확장하는 연쇄가 약함 (fetch_user에서 AI 관련만 필터) |
| 4 | **Co-worker 관계 없음** | 같은 repo에 기여한 사람들 사이의 직접적 관계(co-worker edge)가 그래프에 없음 |
| 5 | **페이지 1개** | 공개 그래프 페이지와 관리자 페이지가 분리되어 있지 않음 |
| 6 | **인증 없음** | 크롤러 시작/중지가 누구나 가능 |
| 7 | **노드 크기 로직** | repo 노드가 다른 노드 대비 특별한 크기 차별이 없음 (요청: 1.15배) |
| 8 | **Fork 관계 미시각화** | fork_source_id를 DB에 저장하지만 그래프에서 전혀 사용하지 않음 |
| 9 | **build_graph() O(N²) 병목** | 매 요청마다 전체 DB 스캔 + in-memory 조인 → 데이터 증가 시 응답 느려짐 |
| 10 | **contributes 링크에 가중치 없음** | contributions 수를 저장하지만 링크 두께에 미반영 |
| 11 | **Language 데이터 미활용** | 메인 언어를 저장하지만 필터/노드에 미사용 |

---

## 개선 사항 목록

### Phase 1: 크롤러 세션 시스템 (Backend)

#### 1-1. `CrawlSession` 모델 추가
**파일**: `backend/app/models.py`

```
CrawlSession:
  id              (PK)
  name            (String)     # 세션 이름 (예: "PyTorch ecosystem", "LLM repos")
  seed_type       (String)     # "search_query" | "repository" | "user"
  seed_value      (String)     # 검색어 또는 repo full_name 또는 user login
  status          (String)     # "running" | "paused" | "completed" | "error"
  max_depth       (Integer)    # 크롤링 확장 깊이 제한 (기본 3)
  total_repos     (Integer)    # 이 세션이 수집한 repo 수 (캐시 카운터)
  total_authors   (Integer)    # 이 세션이 수집한 author 수 (캐시 카운터)
  created_at      (DateTime)
  updated_at      (DateTime)
  paused_at       (DateTime)   # 체크포인트 시점
```

#### 1-2. `CrawlTask`에 세션 FK + depth 추가
**파일**: `backend/app/models.py`

```python
class CrawlTask:
    # 기존 필드 유지 +
    session_id = Column(Integer, ForeignKey("crawl_sessions.id"), nullable=False, index=True)
    depth = Column(Integer, default=0)  # 시드에서 몇 단계 떨어져 있는지
```

- 모든 task는 반드시 하나의 session에 소속
- 세션별로 pending/done/error 집계 가능
- **UniqueConstraint 변경**: `(task_type, target)` → `(session_id, task_type, target)` (세션마다 독립)

#### 1-3. `Author`, `Repository`에 세션 연결
**파일**: `backend/app/models.py`

새 junction table 추가:
```
SessionRepository:
  session_id    (FK → crawl_sessions.id)
  repository_id (FK → repositories.id)

SessionAuthor:
  session_id    (FK → crawl_sessions.id)
  author_id     (FK → authors.id)
```

- 하나의 repo/author가 여러 세션에 속할 수 있음 (다대다)
- 그래프 뷰에서 세션 필터링 가능

---

### Phase 2: 크롤러 엔진 개편 (Backend)

#### 2-1. 크롤러를 세션 기반으로 전환
**파일**: `backend/app/crawler/crawler.py`

**현재**: 단일 GitHubCrawler 인스턴스, `seed_queue()`가 하드코딩된 쿼리 삽입
**변경**:

```python
class CrawlerManager:
    """여러 세션을 관리하는 매니저. 하나의 worker가 전체 세션의 task를 순차 처리."""

    async def create_session(self, name, seed_type, seed_value, max_depth=3) -> CrawlSession:
        # 1. DB에 CrawlSession 생성
        # 2. seed_type에 따라 초기 task 생성 (depth=0):
        #    - "search_query": search_repos task 1개
        #    - "repository": fetch_repo task 1개
        #    - "user": fetch_user task 1개

    async def start_session(self, session_id):
        # session.status → "running"
        # worker가 이미 돌고 있으면 자동으로 해당 세션 task도 처리

    async def pause_session(self, session_id):
        # session.status → "paused" → 해당 세션의 pending task는 skip

    async def resume_session(self, session_id):
        # session.status → "running"

    async def delete_session(self, session_id):
        # 세션과 관련 task 삭제 (수집된 데이터는 유지)
```

**Worker 구조**: 단일 asyncio Task가 전체 session의 pending task를 priority순으로 처리.
→ 여러 세션이 동시에 running이어도 worker는 1개 (rate limit 공유).

#### 2-2. Contributor → Co-worker 확장 로직
**파일**: `backend/app/crawler/crawler.py`

**현재 흐름**:
```
search_repos → save_repo → fetch_contributors → save_author → fetch_user → (AI 관련 repo만 save)
```

**개선 흐름**:
```
[시작점] → search_repos / fetch_repo
  → fetch_contributors (repo의 기여자들)
    → fetch_user (기여자의 상세 정보)
      → 기여자의 다른 repo에서 stars > 50인 것들 수집
        → 해당 repo의 fetch_contributors
          → 반복 확장... (depth ≤ max_depth)
```

핵심 변경:
1. `_do_fetch_user()`에서 AI 관련 필터를 **완화** (stars > 50인 repo는 모두 수집)
2. 수집된 각 repo에 대해 `fetch_contributors` task 자동 생성
3. **depth 제어**: task 생성 시 `depth` 값을 부모 depth+1로 설정
   - depth가 session.max_depth 이하일 때만 하위 task 생성
4. contributor 수집 시 `fetch_user` task도 depth+1로 생성

#### 2-3. Co-worker 관계
**파일**: `backend/app/graph/builder.py`

Co-worker 관계는 **캐시 테이블 + 그래프 빌더** 조합:

**방법**: 그래프 빌더에서 현재 표시 중인 author 노드에 대해서만 동적 계산
```python
# 현재 그래프에 포함된 author들 기준으로만 계산
# → 전체 DB 스캔이 아니라 "화면에 보이는 노드 간" 관계만
if "author" in node_types and len(author_db_ids) > 1:
    # 이 author들이 공통으로 contribute한 repo 찾기
    # SQL: SELECT a1.author_id, a2.author_id, COUNT(*)
    #      FROM repo_contributors a1
    #      JOIN repo_contributors a2 ON a1.repository_id = a2.repository_id
    #      WHERE a1.author_id IN (...) AND a2.author_id IN (...)
    #        AND a1.author_id < a2.author_id
    #      GROUP BY a1.author_id, a2.author_id
    # → coworker 링크 생성 (shared_repos 수를 weight로)
```

---

### Phase 3: 인증 & 관리자 API (Backend)

#### 3-1. 관리자 인증
**파일**: `backend/app/config.py`

```python
class Settings(BaseSettings):
    # 기존 필드 +
    admin_password: str = "admin123"
```

**파일**: `backend/app/api/auth.py` (신규)

```python
# 단순 Bearer Token 방식
# POST /api/admin/login { "password": "..." }
#   → 성공 시 토큰 반환
# 이후 요청: Authorization: Bearer <token>

# FastAPI Dependency:
async def require_admin(request: Request):
    # Authorization 헤더에서 토큰 검증
    # 실패시 401
```

간단한 구현 (외부 의존성 없음):
- `secrets.token_urlsafe(32)`로 토큰 생성
- 서버 메모리 dict에 `{token: created_at}` 보관
- 토큰 만료: 24시간
- 서버 재시작 시 재로그인 필요

#### 3-2. 관리자 API 엔드포인트
**파일**: `backend/app/api/admin.py` (신규)

```
POST   /api/admin/login              # 암호 확인 → 토큰 발급
GET    /api/admin/sessions           # 전체 세션 목록
POST   /api/admin/sessions           # 새 세션 생성 (name, seed_type, seed_value, max_depth)
GET    /api/admin/sessions/{id}      # 세션 상세 (task 통계 포함)
POST   /api/admin/sessions/{id}/start   # 세션 시작/재개
POST   /api/admin/sessions/{id}/pause   # 세션 일시정지
DELETE /api/admin/sessions/{id}      # 세션 삭제
GET    /api/admin/sessions/{id}/tasks    # 해당 세션의 task 목록 (페이지네이션)
GET    /api/admin/crawler/status     # 전체 워커 상태 (rate limit 등)
```

#### 3-3. 공개 API 변경
**파일**: `backend/app/api/routes.py`

```
GET    /api/graph?session_id=...     # 세션 필터 추가
GET    /api/sessions                 # 공개: 세션 목록 (이름, 상태, 통계만)
GET    /api/stats?session_id=...     # 세션별 통계
```

- 기존 `/api/crawler/start`, `/api/crawler/stop`, `/api/crawler/status` → **삭제**
- 크롤러 제어는 admin API로 이동

---

### Phase 4: 프론트엔드 2페이지 구조

#### 4-1. 라우팅 추가
**파일**: `frontend/package.json` → `react-router-dom` 추가

**파일**: `frontend/src/main.jsx`
```jsx
<BrowserRouter>
  <Routes>
    <Route path="/" element={<GraphPage />} />
    <Route path="/admin" element={<AdminPage />} />
  </Routes>
</BrowserRouter>
```

#### 4-2. 공개 그래프 페이지 (`GraphPage`)
**파일**: `frontend/src/pages/GraphPage.jsx` (App.jsx에서 분리)

변경사항:
- 크롤러 제어 UI 제거 (Sidebar에서 Crawler 섹션 삭제)
- **세션 선택 드롭다운** 추가 (어떤 세션의 데이터를 볼지)
- 기존 필터 + 검색 + 그래프 뷰 유지
- "All Sessions" 옵션으로 전체 데이터 보기

#### 4-3. 관리자 페이지 (`AdminPage`)
**파일**: `frontend/src/pages/AdminPage.jsx` (신규)

**로그인 화면**:
- 비밀번호 입력 → POST /api/admin/login
- 토큰을 sessionStorage에 저장
- 실패 시 에러 표시

**대시보드** (로그인 후):
```
┌─────────────────────────────────────────────────────┐
│  Admin Dashboard                        [Logout]    │
├──────────┬──────────────────────────────────────────┤
│          │                                          │
│ Sessions │  Session Detail / New Session Form       │
│ ──────── │  ────────────────────────────────────     │
│ □ PyTorch│  Name: PyTorch Ecosystem                 │
│   eco... │  Seed: topic:pytorch stars:>100          │
│          │  Status: ● Running                       │
│ □ LLM    │  Progress: 45 repos, 120 authors         │
│   repos  │  Pending: 234 tasks                      │
│          │  Done: 89 tasks                           │
│ [+ New]  │  Errors: 2                               │
│          │                                          │
│          │  [Pause] [Delete]                        │
│          │                                          │
│          │  Recent Tasks:                           │
│          │  ✓ search_repos "pytorch..."             │
│          │  ✓ fetch_repo "pytorch/pytorch"          │
│          │  ⟳ fetch_contributors "..."              │
│          │  ✗ fetch_user "..." (rate limit)         │
│          │                                          │
└──────────┴──────────────────────────────────────────┘
```

**새 세션 생성 폼**:
```
┌─────────────────────────────────────┐
│  Create New Crawler Session         │
│                                     │
│  Session Name: [________________]   │
│                                     │
│  Seed Type:                         │
│    ○ Search Query                   │
│    ○ Repository                     │
│    ○ User                           │
│                                     │
│  Seed Value: [________________]     │
│  (예: "topic:pytorch stars:>100"    │
│   또는 "pytorch/pytorch"            │
│   또는 "yunjey")                    │
│                                     │
│  Max Depth: [3] (1-5)              │
│                                     │
│  [Create & Start]                   │
└─────────────────────────────────────┘
```

---

### Phase 5: 그래프 데이터 풍부화 & 시각화 개선

#### 5-1. Fork 관계 시각화 (새로 추가)
**현재**: `fork_source_id`를 DB에 저장하지만 그래프에서 사용하지 않음
**개선**: fork 관계를 그래프 링크로 추가

**파일**: `backend/app/graph/builder.py`

```python
# fork 링크 추가
if "repo" in node_types:
    forked_repos = [r for r in repos if r.fork_source_id and f"repo:{r.fork_source_id}" in node_ids]
    for r in forked_repos:
        links.append({
            "source": f"repo:{r.id}",
            "target": f"repo:{r.fork_source_id}",
            "type": "forked_from",
        })
```

**시각화 색상**: `forked_from: "rgba(136,136,204,0.30)"` (연보라 점선)

#### 5-2. contribute 링크 가중치 (새로 추가)
**현재**: `RepoContributor.contributions` 수를 저장하지만 링크에 미반영
**개선**: contributions 수를 링크 weight로 전달 → 프론트에서 선 두께 조절

**파일**: `backend/app/graph/builder.py`
```python
links.append({
    "source": src, "target": tgt,
    "type": "contributes",
    "weight": min(c.contributions / 100, 3),  # 0.01 ~ 3 범위
})
```

**파일**: `frontend/src/components/GraphView.jsx`
```javascript
linkWidth={(link) => (link.weight || 0.5)}
```

#### 5-3. Language 필터 (새로 추가)
**현재**: `Repository.language`를 저장하지만 필터에 미사용
**개선**: 사이드바에 Language 필터 드롭다운 추가

**파일**: `backend/app/api/routes.py`
```python
@router.get("/graph")
async def get_graph(..., language: str = Query(default=None)):
    # language가 지정되면 해당 언어 repo만 필터
```

**파일**: `frontend/src/components/Sidebar.jsx`
```
Language: [All ▼]  ← Python, JavaScript, C++, Rust 등
```

Language를 별도 노드 타입으로 만들지는 않음 (topic과 역할 겹침).
대신 **필터**로 활용하여 "Python으로 작성된 AI repo만 보기" 가능.

#### 5-4. 노드 크기 조정
**파일**: `frontend/src/components/GraphView.jsx`

```javascript
const paintNode = (node, ctx, globalScale) => {
    let r = Math.max(Math.sqrt(node.val || 1) * 2, 3);

    // Repo 노드: 1.15배 확대
    if (node.type === "repo") {
        r *= 1.15;
    }

    // val은 이미 연결 수를 반영하므로 자연스럽게 차등
};
```

#### 5-5. Co-worker 링크 시각화
**파일**: `frontend/src/components/GraphView.jsx`

```javascript
const LINK_COLORS = {
    owns: "rgba(88,166,255,0.35)",
    contributes: "rgba(139,148,158,0.25)",
    has_topic: "rgba(210,153,34,0.25)",
    coworker: "rgba(218,112,214,0.30)",    // 보라 (새로 추가)
    forked_from: "rgba(136,136,204,0.30)", // 연보라 (새로 추가)
};
```

#### 5-6. 그래프 빌더에 연결 수 → val 보정
**파일**: `backend/app/graph/builder.py`

```python
# 노드 생성 후, 링크 개수를 val에 반영
for node in nodes:
    connection_count = sum(
        1 for l in links
        if l["source"] == node["id"] or l["target"] == node["id"]
    )
    node["val"] = node["val"] + connection_count * 0.3
```

---

### Phase 6: 서버 부하 최소화 전략

#### 6-1. 그래프 응답 캐싱 (Backend)
**문제**: `build_graph()`는 매 요청마다 DB 쿼리 5~6개 + in-memory 조인 수행.
데이터 1,000+ repo에서 요청당 100ms~500ms 예상.

**해결**: 인메모리 TTL 캐시

**파일**: `backend/app/graph/cache.py` (신규)

```python
import time
from typing import Any

class GraphCache:
    def __init__(self, ttl: int = 30):
        self._cache: dict[str, tuple[float, Any]] = {}
        self.ttl = ttl  # 초 단위

    def get(self, key: str) -> Any | None:
        if key in self._cache:
            ts, data = self._cache[key]
            if time.time() - ts < self.ttl:
                return data
            del self._cache[key]
        return None

    def set(self, key: str, data: Any):
        self._cache[key] = (time.time(), data)

    def invalidate(self):
        """크롤러가 데이터를 커밋할 때 호출"""
        self._cache.clear()

graph_cache = GraphCache(ttl=30)
```

**적용 위치**: `routes.py`에서 `/api/graph` 요청 시:
```python
cache_key = f"{session_id}:{limit}:{min_stars}:{types}:{search}:{language}"
cached = graph_cache.get(cache_key)
if cached:
    return cached
result = await GraphBuilder.build_graph(...)
graph_cache.set(cache_key, result)
return result
```

**무효화**: 크롤러가 `session.commit()` 할 때마다 `graph_cache.invalidate()` 호출
→ 크롤링 중에는 30초 TTL로 자동 갱신, 유저 폴링에 DB 부하 없음

#### 6-2. build_graph() 쿼리 최적화
**현재 문제**:
```python
# 1. ownerlink 중복 체크: O(N) × links 수
existing_own = any(
    l["source"] == src and l["target"] == tgt and l["type"] == "owns"
    for l in links
)
```
이 루프가 contributor마다 전체 links를 스캔 → O(contributors × links)

**해결**: set 기반 룩업
```python
own_link_keys: set[tuple[str, str]] = set()
# owns 링크 생성 시:
own_link_keys.add((f"author:{r.owner_id}", f"repo:{r.id}"))
# contributes 확인 시:
if (src, tgt) not in own_link_keys:
    links.append(...)
```

#### 6-3. Co-worker 계산 최적화
**문제**: 순진한 구현은 O(authors² × repos)

**해결**: SQL 레벨에서 집계
```sql
SELECT a1.author_id AS aid1, a2.author_id AS aid2, COUNT(*) AS shared
FROM repo_contributors a1
JOIN repo_contributors a2
  ON a1.repository_id = a2.repository_id AND a1.author_id < a2.author_id
WHERE a1.author_id IN (:ids) AND a2.author_id IN (:ids)
GROUP BY a1.author_id, a2.author_id
HAVING COUNT(*) >= 1
```
- `IN (:ids)`가 현재 화면 author만 대상 → 풀스캔 방지
- `a1.author_id < a2.author_id`로 중복 쌍 방지
- 인덱스: `repo_contributors(author_id)`, `repo_contributors(repository_id)` (이미 존재)

#### 6-4. 크롤러 API 부하 최소화
**현재 문제**:
- `get_status()`가 매 호출마다 `COUNT(*)` 쿼리 5개 실행
- 프론트가 10초마다 폴링 → 10초마다 5개 COUNT

**해결**: CrawlSession에 **카운터 캐시 필드** 활용

```python
class CrawlSession:
    total_repos = Column(Integer, default=0)     # 크롤러가 save 시 +1
    total_authors = Column(Integer, default=0)    # 크롤러가 save 시 +1
    tasks_pending = Column(Integer, default=0)    # task 추가 시 +1, 처리 시 -1
    tasks_done = Column(Integer, default=0)       # task 완료 시 +1
    tasks_errors = Column(Integer, default=0)     # task 에러 시 +1
```

→ status API는 `SELECT * FROM crawl_sessions` 1개로 해결
→ COUNT 쿼리 = 0

**단, 정확도 보장**: 크롤러가 task 상태 변경 시 session 카운터도 함께 업데이트
→ 같은 트랜잭션에서 처리하므로 일관성 보장

#### 6-5. 프론트엔드 폴링 최적화
**현재**: 10초마다 `/api/crawler/status` 폴링
**개선**:
- 크롤러가 running이 아닌 경우: 폴링 주기 60초로 증가
- running인 경우: 15초 (10초 → 15초)
- 그래프 자동 갱신: 크롤러 running이고 데이터 변화 감지 시에만 refresh
  - 감지 방법: status 응답의 `total_repos` 변화 체크

```javascript
const pollInterval = crawlerStatus.running ? 15_000 : 60_000;
```

#### 6-6. 그래프 응답 크기 최소화
**현재**: 모든 노드에 description, avatar_url 등 전체 정보 포함
**개선**: 경량 모드 + 상세 모드 분리

```python
# GET /api/graph?compact=true (기본 그래프 렌더링용)
# → 노드: { id, type, label, val } 만 반환
# → 링크: { source, target, type } 만 반환

# GET /api/graph/node/{node_id} (노드 클릭 시 상세)
# → { id, type, label, description, stars, followers, language, ... }
```

→ 300노드 그래프의 JSON 크기: ~150KB → ~30KB (약 80% 감소)

#### 6-7. DB 인덱스 추가
**파일**: `backend/app/models.py`

```python
class Repository:
    __table_args__ = (
        Index("ix_repos_stars", "stars"),           # 이미 ORDER BY stars DESC 빈번
        Index("ix_repos_owner_stars", "owner_id", "stars"),  # 특정 owner의 repo 정렬
        Index("ix_repos_language", "language"),      # language 필터
    )

class RepoContributor:
    __table_args__ = (
        ...,
        Index("ix_contrib_author", "author_id"),     # co-worker 조인
        Index("ix_contrib_repo", "repository_id"),   # contributor 목록
    )

class CrawlTask:
    __table_args__ = (
        ...,
        Index("ix_tasks_session_status", "session_id", "status"),  # 세션별 task 조회
    )
```

---

### Phase 7: .env & Config 업데이트

#### 7-1. 설정 추가
**파일**: `backend/app/config.py`

```python
class Settings(BaseSettings):
    # 기존 +
    admin_password: str = "admin123"
    graph_cache_ttl: int = 30       # 그래프 캐시 TTL (초)
```

#### 7-2. Docker 환경변수
**파일**: `docker-compose.yml`

```yaml
backend:
  environment:
    - ADMIN_PASSWORD=${ADMIN_PASSWORD:-admin123}
    - GRAPH_CACHE_TTL=${GRAPH_CACHE_TTL:-30}
```

#### 7-3. .env.example 업데이트
```
GITHUB_TOKEN=ghp_xxxxxxxxxxxx
ADMIN_PASSWORD=admin123
GRAPH_CACHE_TTL=30
```

---

## 파일 수정/생성 요약

### Backend 수정
| 파일 | 작업 |
|------|------|
| `models.py` | CrawlSession(카운터 캐시 포함), SessionRepository, SessionAuthor 추가. CrawlTask에 session_id, depth 추가. Repository/RepoContributor에 인덱스 추가 |
| `config.py` | admin_password, graph_cache_ttl 필드 추가 |
| `crawler/crawler.py` | CrawlerManager 클래스로 전환. 세션 기반 크롤링. depth 제어. contributor 확장 강화. 세션 카운터 갱신. 캐시 무효화 호출 |
| `crawler/seeds.py` | 하드코딩된 쿼리 유지 (기본 시드로 사용 가능) |
| `graph/builder.py` | session_id 필터, co-worker 링크(SQL 집계), fork 링크, contributes weight, 연결 수 val 보정, compact 모드, set 기반 owns 룩업 |
| `api/routes.py` | session_id/language/compact 파라미터 추가, crawler 엔드포인트 제거, /api/sessions 공개, /api/graph/node/{id} 추가, 캐시 적용 |
| `main.py` | CrawlerManager 사용, 라우터 등록 변경 |
| `database.py` | 변경 없음 |

### Backend 신규
| 파일 | 목적 |
|------|------|
| `api/auth.py` | 관리자 인증 (토큰 발급/검증) |
| `api/admin.py` | 관리자 전용 엔드포인트 (세션 CRUD, 크롤러 제어) |
| `graph/cache.py` | TTL 기반 인메모리 그래프 캐시 |

### Frontend 수정
| 파일 | 작업 |
|------|------|
| `package.json` | react-router-dom 추가 |
| `main.jsx` | BrowserRouter + Routes 설정 |
| `App.jsx` | → `pages/GraphPage.jsx`로 이동/리팩터. 크롤러 UI 제거, 세션 선택 추가, compact 모드 |
| `components/GraphView.jsx` | repo 1.15배, co-worker/fork 링크 색상, contributes 두께, forked_from 점선 |
| `components/Sidebar.jsx` | 크롤러 섹션 제거, 세션 선택, language 필터, co-worker/fork legend, 노드 상세는 클릭 시 API |
| `index.css` | 관리자 페이지 스타일, language 필터 스타일 |

### Frontend 신규
| 파일 | 목적 |
|------|------|
| `pages/GraphPage.jsx` | 공개 그래프 페이지 (App.jsx에서 분리) |
| `pages/AdminPage.jsx` | 관리자 대시보드 (로그인, 세션 관리) |
| `components/SessionSelector.jsx` | 세션 드롭다운 컴포넌트 |
| `components/AdminLogin.jsx` | 로그인 폼 컴포넌트 |
| `components/SessionList.jsx` | 세션 목록 컴포넌트 |
| `components/SessionDetail.jsx` | 세션 상세 + 제어 컴포넌트 |
| `components/NewSessionForm.jsx` | 새 세션 생성 폼 |

### Infra 수정
| 파일 | 작업 |
|------|------|
| `docker-compose.yml` | ADMIN_PASSWORD, GRAPH_CACHE_TTL 환경변수 추가 |
| `nginx/nginx.conf` | /admin 경로 프론트엔드로 전달 (SPA fallback) |
| `.env.example` | ADMIN_PASSWORD, GRAPH_CACHE_TTL 추가 |

---

## 실행 순서

```
Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6 → Phase 7
 모델      크롤러     인증/API   프론트     시각화      최적화     설정
```

각 Phase 완료 후 로컬 테스트 → 다음 Phase 진행.
전체 완료 후 `docker compose up -d --build`로 배포.

---

## 데이터 흐름 (개선 후)

```
[관리자가 세션 생성]
  └─ seed_type: "search_query", seed_value: "topic:pytorch stars:>100"
      │
      ▼
[CrawlSession #1 생성] → [CrawlTask: search_repos, depth=0]
      │
      ▼
[search_repos 실행] → repo A, repo B, repo C 수집
      │                   (SessionRepository에 session_id=1로 기록)
      │                   (session.total_repos += 3)
      │                   (graph_cache.invalidate())
      ▼
[fetch_contributors, depth=1] → repo A의 contributor X, Y, Z 수집
      │                          (SessionAuthor에 session_id=1로 기록)
      │                          (session.total_authors += 3)
      ▼
[fetch_user X, depth=2] → X의 다른 repo D, E 수집 (stars > 50이면 수집)
      │                     (repo D, E도 SessionRepository에 기록)
      │                     (fetch_contributors for D, E 생성, depth=3)
      ▼
[fetch_contributors repo D, depth=3 = max_depth] → contributor W 수집
      │   (fetch_user W는 depth=4 > max_depth → 생성하지 않음)

      ▼
[그래프 빌더] (캐시 miss 시에만 실행)
  - repo A, B, C, D, E  (fork 관계 있으면 forked_from 링크)
  - author X, Y, Z, W
  - topic들
  - owns 링크 (author → repo)
  - contributes 링크 (author → repo, weight = contributions/100)
  - coworker 링크 (같은 repo에 기여한 author ↔ author, SQL 집계)
  - has_topic 링크 (repo → topic)
  - forked_from 링크 (fork → source repo)
  → 결과를 graph_cache에 30초 TTL로 저장
```

---

## 핵심 설계 결정

### 그래프 풍부화
1. **Fork 관계를 링크로 추가**
   - 이미 DB에 `fork_source_id`를 저장 중 → 추가 API 호출 불필요
   - fork 체인을 따라가면 같은 뿌리의 프로젝트 계보가 시각화됨

2. **contributes 가중치 반영**
   - `contributions` 수를 이미 DB에 저장 중 → 링크 `weight` 필드로 전달
   - 프론트에서 `linkWidth` prop으로 선 두께 조절
   - 핵심 기여자 vs 가벼운 기여자가 시각적으로 구분됨

3. **Language 필터 (노드 아님)**
   - Language를 별도 노드로 만들면 topic과 역할 중복 + 모든 repo가 연결되어 시각적 노이즈
   - 대신 **필터**로: "Python AI repos만 보기" → 깔끔한 서브그래프

4. **Company/Organization은 추가하지 않음**
   - `company` 필드가 자유 텍스트 ("@google", "Google LLC", "Google, Inc." 등) → 정규화 비용 높음
   - GitHub Organization API는 별도 엔드포인트 + 추가 rate limit
   - 추후 필요하면 Phase 8로 분리

### 성능 최적화
5. **Co-worker 관계: SQL 집계 (in-memory X)**
   - Python에서 O(N²) 루프 → SQL `JOIN + GROUP BY`로 DB 엔진에 위임
   - WHERE 절로 현재 화면 author만 대상 → 풀스캔 방지

6. **인메모리 TTL 캐시 (Redis 불필요)**
   - 단일 FastAPI 인스턴스 → 프로세스 내 dict로 충분
   - Redis 추가하면 Docker service + 연결 관리 + 직렬화 오버헤드
   - 30초 TTL: 크롤링 중에도 최신 데이터 반영 (복수 유저가 동시에 보면 캐시 히트)

7. **세션 카운터 캐시 (COUNT 쿼리 제거)**
   - 크롤러가 데이터 저장 시 세션의 카운터 필드를 함께 UPDATE
   - status API: `SELECT * FROM crawl_sessions WHERE id = ?` 1개로 해결
   - 기존: COUNT(*) 5개 → 개선: 0개

8. **compact 모드 (그래프 JSON 경량화)**
   - 기본 그래프 렌더링에 description, avatar_url 등 불필요
   - `?compact=true` → JSON 크기 ~80% 감소
   - 노드 클릭 시에만 `/api/graph/node/{id}`로 상세 정보 요청

9. **owns 중복 체크: O(1) set 룩업**
   - 현재: `any(l for l in links if ...)` → O(links) per contributor
   - 개선: `set[tuple[str,str]]` → O(1) per contributor

10. **프론트 폴링 주기 적응**
    - idle 시 60초, active 시 15초 → 불필요한 API 호출 ~75% 감소

### 아키텍처 결정
11. **단일 Worker (여러 세션 통합 처리)**
    - GitHub rate limit이 5,000/hr (token 사용 시) → 세션별 worker는 낭비
    - 모든 세션의 task를 priority 순으로 하나의 루프가 처리
    - 세션 pause/resume은 task 선택 시 `session.status == "running"` 필터로 구현

12. **depth 제어로 크롤링 폭발 방지**
    - depth 0: 시드 task
    - depth 1: 시드에서 직접 발견된 repo/user
    - depth 2: 1차 확장
    - depth 3 (기본 max): 최대 확장
    - 이를 통해 무한 크롤링 방지

13. **인증은 최소한으로**
    - 외부 라이브러리 없이 `secrets.token_urlsafe(32)`
    - sessionStorage 기반 (탭 닫으면 로그아웃)
    - 읽기 API는 인증 불필요, 쓰기(세션 생성/제어)만 인증 필요
