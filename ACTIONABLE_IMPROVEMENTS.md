# GitHub AI Network - 실행 가능한 개선 사항

> 현재 스택(SQLite, FastAPI, React, Three.js) 내에서 즉시 적용 가능한 개선 항목만 정리
> 아키텍처 변경(Redis, PostgreSQL 등) 없이 코드 수정만으로 해결 가능한 것들

---

## 1. 보안 (즉시 수행)

### 1.1 [CRITICAL] Admin 비밀번호 안전한 비교

**현재:** `password == ADMIN_PASSWORD` (평문 비교, 타이밍 공격 취약)

**개선:**
```python
import hmac
# hmac.compare_digest()로 상수 시간 비교
if not hmac.compare_digest(password.encode(), ADMIN_PASSWORD.encode()):
    raise HTTPException(401)
```

- 추가 패키지 불필요 (`hmac`은 Python 내장)
- 환경변수 미설정 시 서버 시작 거부 로직 추가

**파일:** `backend/app/api/auth.py`, `backend/app/config.py`

### 1.2 [CRITICAL] 공개 API 간이 Rate Limiting

**현재:** `/api/graph` 등 무제한 호출 가능 → DB 과부하 위험

**개선:** FastAPI 미들웨어로 IP별 요청 횟수 제한
```python
# 인메모리 딕셔너리로 간이 구현 (외부 패키지 없이)
from collections import defaultdict
import time

request_counts: dict[str, list[float]] = defaultdict(list)

@app.middleware("http")
async def rate_limit(request, call_next):
    ip = request.client.host
    now = time.time()
    # 최근 60초 요청만 유지
    request_counts[ip] = [t for t in request_counts[ip] if now - t < 60]
    if len(request_counts[ip]) > 60:  # 분당 60회
        return JSONResponse(status_code=429, content={"error": "Too many requests"})
    request_counts[ip].append(now)
    return await call_next(request)
```

**파일:** `backend/app/main.py`

### 1.3 [HIGH] CORS 도메인 제한

**현재:** `allow_origins=["*"]`

**개선:** 환경변수에서 허용 도메인 목록 읽기
```python
origins = os.getenv("CORS_ORIGINS", "https://ai-network.hrletsgo.me").split(",")
```

**파일:** `backend/app/main.py`

---

## 2. 백엔드 코드 품질

### 2.1 [HIGH] Graph Builder N+1 쿼리 개선

**현재:** 레포마다 개별 토픽/기여자 쿼리 → 300개 레포 = 600+ 쿼리

**개선:** `selectinload`로 일괄 로드
```python
from sqlalchemy.orm import selectinload

repos = await db.execute(
    select(Repository)
    .options(selectinload(Repository.topics))
    .options(selectinload(Repository.contributors))
    .where(...)
    .limit(limit)
)
```

또는 별도 IN 쿼리로 한번에 조회:
```python
repo_ids = [r.id for r in repos]
all_topics = await db.execute(
    select(RepoTopic, Topic)
    .join(Topic)
    .where(RepoTopic.repository_id.in_(repo_ids))
)
# dict로 매핑 후 할당
```

**파일:** `backend/app/graph/builder.py`

### 2.2 [HIGH] HTTP 상태 코드 정상화

**현재:** 에러 시에도 200 OK + `{"error": "Not found"}` 반환

**개선:**
```python
from fastapi import HTTPException

if not repo:
    raise HTTPException(status_code=404, detail="Node not found")
```

**파일:** `backend/app/api/routes.py`

### 2.3 [MEDIUM] 구조화된 로깅

**현재:** `print()` 기반

**개선:** Python 내장 `logging` 모듈 활용
```python
import logging
logging.basicConfig(
    format='%(asctime)s %(levelname)s %(name)s: %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)
logger.info("Crawl session %d started", session_id)
```

**파일:** 전체 백엔드 (`print` → `logger`)

### 2.4 [MEDIUM] 헬스체크 엔드포인트

**추가:**
```python
@router.get("/health")
async def health(db: AsyncSession = Depends(get_db)):
    try:
        await db.execute(text("SELECT 1"))
        return {"status": "ok", "db": "connected"}
    except Exception:
        return JSONResponse(status_code=503, content={"status": "error", "db": "disconnected"})
```

**파일:** `backend/app/api/routes.py`

### 2.5 [LOW] 토큰 만료 자동 정리

**현재:** 로그인 시점에만 만료 토큰 정리

**개선:** FastAPI lifespan에 background task 추가
```python
async def cleanup_tokens():
    while True:
        await asyncio.sleep(3600)  # 1시간마다
        now = time.time()
        expired = [k for k, v in active_tokens.items() if now - v > TOKEN_TTL]
        for k in expired:
            del active_tokens[k]
```

**파일:** `backend/app/api/auth.py`, `backend/app/main.py`

---

## 3. 프론트엔드 코드 품질

### 3.1 [HIGH] Three.js 리소스 정리 강화

**현재:** renderer.dispose()는 하지만 개별 geometry/material dispose가 불완전할 수 있음

**개선:** cleanup에서 명시적으로 모든 리소스 해제
```javascript
return () => {
    // 애니메이션 중지
    cancelAnimationFrame(rafRef.current);
    
    // Three.js 리소스 개별 해제
    scene.traverse(obj => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
            if (Array.isArray(obj.material)) {
                obj.material.forEach(m => m.dispose());
            } else {
                obj.material.dispose();
            }
        }
    });
    
    // Bloom composer
    if (composerRef.current) {
        composerRef.current.passes.forEach(p => p.dispose?.());
    }
    
    renderer.dispose();
    renderer.forceContextLoss();
};
```

**파일:** `frontend/src/components/GraphView3DLarge.jsx`

### 3.2 [HIGH] React Error Boundary

**추가:** 3D 그래프 크래시 시 전체 앱 대신 fallback 표시

```jsx
// ErrorBoundary.jsx (새 파일, 약 30줄)
class GraphErrorBoundary extends React.Component {
    state = { hasError: false };
    static getDerivedStateFromError() { return { hasError: true }; }
    render() {
        if (this.state.hasError) {
            return <div className="graph-error">
                <p>그래프 렌더링 중 오류가 발생했습니다.</p>
                <button onClick={() => this.setState({ hasError: false })}>다시 시도</button>
            </div>;
        }
        return this.props.children;
    }
}
```

GraphPage에서:
```jsx
<GraphErrorBoundary>
    <GraphView3DLarge ... />
</GraphErrorBoundary>
```

**파일:** `frontend/src/components/ErrorBoundary.jsx` (신규), `frontend/src/pages/GraphPage.jsx`

### 3.3 [MEDIUM] 필터 상태 URL 동기화

**현재:** 새로고침 시 필터 초기화

**개선:** URL 쿼리 파라미터로 필터 유지
```javascript
// useSearchParams로 필터 상태 관리
const [searchParams, setSearchParams] = useSearchParams();

const language = searchParams.get('lang') || '';
const types = searchParams.get('types') || 'author,repo,topic';
const search = searchParams.get('q') || '';

// 필터 변경 시
const updateFilter = (key, value) => {
    setSearchParams(prev => { prev.set(key, value); return prev; });
};
```

**파일:** `frontend/src/pages/GraphPage.jsx`

### 3.4 [MEDIUM] 검색 결과 → 카메라 이동

**현재:** 검색 결과 클릭 시 노드 선택만, 3D 공간에서 찾기 어려움

**개선:** 선택된 노드로 카메라 fly-to 애니메이션
```javascript
const flyToNode = (nodeId) => {
    const node = nodesRef.current.find(n => n.id === nodeId);
    if (!node || !node.x) return;
    
    const target = new THREE.Vector3(node.x, node.y, node.z);
    const offset = target.clone().add(new THREE.Vector3(0, 0, 150));
    
    // 간단한 lerp 애니메이션
    const start = camera.position.clone();
    let t = 0;
    const animate = () => {
        t += 0.03;
        if (t >= 1) return;
        camera.position.lerpVectors(start, offset, t);
        camera.lookAt(target);
        requestAnimationFrame(animate);
    };
    animate();
};
```

**파일:** `frontend/src/components/GraphView3DLarge.jsx`

### 3.5 [LOW] AdminPage 컴포넌트 분리

**현재:** ~700줄 단일 파일

**개선:** 로직별 분리 (아키텍처 변경 아님, 파일 분리만)
```
pages/
  AdminPage.jsx          (메인 레이아웃 + 탭 전환만)
  admin/
    SessionManager.jsx   (세션 CRUD)
    CrawlerControl.jsx   (크롤러 시작/중지/상태)
    TaskInjector.jsx     (수동 태스크 추가)
```

**파일:** `frontend/src/pages/AdminPage.jsx` → 분리

---

## 4. UX 개선

### 4.1 [HIGH] 노드 우클릭 컨텍스트 메뉴

**현재:** 우클릭 = 브라우저 기본 메뉴

**개선:**
```
┌─────────────────────────┐
│ 🔗 GitHub에서 열기       │
│ 🔍 연결된 노드만 보기    │
│ 📋 정보 복사            │
│ 👁 숨기기               │
└─────────────────────────┘
```

- `onContextMenu` 이벤트로 raycasting → 해당 노드 위에 메뉴 렌더링
- 메뉴 항목은 노드 타입별로 다르게 구성

**파일:** `frontend/src/components/GraphView3DLarge.jsx`, `frontend/src/index.css`

### 4.2 [HIGH] 로딩 상태 개선

**현재:** 그래프 데이터 로딩 중 빈 화면

**개선:** Skeleton UI + 진행률 표시
```jsx
{loading && (
    <div className="graph-loading">
        <div className="loading-spinner" />
        <p>그래프 데이터 로딩 중... ({nodeCount}개 노드)</p>
    </div>
)}
```

**파일:** `frontend/src/pages/GraphPage.jsx`, `frontend/src/index.css`

### 4.3 [MEDIUM] 키보드 단축키

**추가:**
| 단축키 | 동작 |
|--------|------|
| `F` | 전체화면 토글 |
| `Esc` | 모달 닫기 / 전체화면 해제 |
| `/` | 검색창 포커스 |
| `R` | 카메라 초기 위치로 리셋 |
| `1`, `2`, `3` | 노드 타입 필터 토글 |

**파일:** `frontend/src/pages/GraphPage.jsx`

### 4.4 [MEDIUM] 조작 안내 오버레이

**현재:** 3D 조작 방법 안내 없음

**개선:** 첫 방문 시 또는 `?` 키로 오버레이 표시
```
┌───────────────────────────────────┐
│  🖱 좌클릭 드래그: 회전           │
│  🖱 우클릭 드래그: 이동           │
│  🖱 스크롤: 줌                   │
│  🖱 노드 클릭: 선택              │
│  🖱 노드 더블클릭: 상세 보기      │
│  ⌨ F: 전체화면  /: 검색          │
│                                   │
│  [다시 보지 않기]                  │
└───────────────────────────────────┘
```

`localStorage`로 "다시 보지 않기" 상태 저장

**파일:** `frontend/src/components/HelpOverlay.jsx` (신규), `frontend/src/pages/GraphPage.jsx`

### 4.5 [LOW] 그래프 스크린샷 캡처

**추가:** 현재 뷰를 PNG로 저장
```javascript
const captureScreenshot = () => {
    renderer.render(scene, camera);
    const link = document.createElement('a');
    link.download = `ai-network-${Date.now()}.png`;
    link.href = renderer.domElement.toDataURL('image/png');
    link.click();
};
```

**파일:** `frontend/src/components/GraphView3DLarge.jsx`

---

## 5. 성능 최적화

### 5.1 [HIGH] 라벨 LOD (Level of Detail)

**현재:** 모든 라벨이 항상 렌더링

**개선:** 카메라 거리에 따라 라벨 표시/숨기기
```javascript
// 매 프레임 렌더링 루프에서
labelGroup.children.forEach(sprite => {
    const dist = camera.position.distanceTo(sprite.position);
    sprite.visible = dist < 500;  // 가까운 라벨만 표시
    if (sprite.visible) {
        sprite.scale.setScalar(dist * 0.1);  // 거리에 비례 스케일
    }
});
```

**파일:** `frontend/src/components/GraphView3DLarge.jsx`

### 5.2 [HIGH] Worker 메시지 최적화

**현재:** 매 틱마다 전체 Float32Array 복사 + postMessage

**개선:** Transferable Objects 사용
```javascript
// layout.worker.js
const buffer = new Float32Array(n * 3);
// ... 위치 데이터 채우기 ...
postMessage({ type: 'tick', positions: buffer.buffer }, [buffer.buffer]);
```

- structured clone 비용 제거
- 대규모 그래프에서 의미있는 성능 차이

**파일:** `frontend/src/workers/layout.worker.js`

### 5.3 [MEDIUM] 번들 크기 — Three.js 트리셰이킹

**현재:** `import * as THREE from 'three'`

**개선:** 필요한 클래스만 개별 import
```javascript
import { Scene, WebGLRenderer, PerspectiveCamera, ... } from 'three';
```

- Vite의 트리셰이킹이 더 효과적으로 작동
- 번들 크기 10-30% 감소 기대

**파일:** `frontend/src/components/GraphView3DLarge.jsx`

### 5.4 [MEDIUM] 추가 Lazy Loading

**현재:** GraphView3DLarge만 lazy

**개선:**
```javascript
const AdminPage = lazy(() => import('./pages/AdminPage'));
const NodeDetailModal = lazy(() => import('./components/NodeDetailModal'));
const TableView = lazy(() => import('./components/TableView'));
```

**파일:** `frontend/src/App.jsx`

### 5.5 [LOW] 그래프 데이터 로컬 캐싱

**개선:** IndexedDB에 이전 그래프 데이터 캐싱
```javascript
// 로딩 시: IndexedDB에서 캐시 확인 → 있으면 즉시 표시 → API에서 최신 데이터 fetch → 업데이트
const cachedData = await idb.get('graph-cache', cacheKey);
if (cachedData) {
    setGraphData(cachedData);  // 즉시 표시
}
const freshData = await fetch('/api/graph?...');
setGraphData(freshData);
await idb.put('graph-cache', cacheKey, freshData);  // 캐시 갱신
```

- `idb-keyval` (2KB) 또는 raw IndexedDB API 사용
- 첫 화면 표시까지의 시간 대폭 단축

**파일:** `frontend/src/pages/GraphPage.jsx`

---

## 6. 데이터베이스 (SQLite 내에서)

### 6.1 [HIGH] 인덱스 추가

**현재 모델에 추가 가능한 인덱스:**
```python
# models.py
class Repository(Base):
    # 기존 인덱스 외 추가
    __table_args__ = (
        Index('ix_repo_owner_stars', 'owner_id', 'stars'),
        Index('ix_repo_language', 'language'),
    )

class RepoContributor(Base):
    __table_args__ = (
        Index('ix_contrib_author', 'author_id'),
        UniqueConstraint('repository_id', 'author_id'),
    )
```

- 기존 incremental migration 로직에서 자동 적용

**파일:** `backend/app/models.py`, `backend/app/database.py`

### 6.2 [MEDIUM] 검색 성능 — FTS5

**현재:** `LIKE '%keyword%'` (전체 스캔)

**개선:** SQLite FTS5 가상 테이블 활용
```sql
CREATE VIRTUAL TABLE IF NOT EXISTS repo_fts USING fts5(
    full_name, description, content=repositories
);
-- 검색 시
SELECT * FROM repo_fts WHERE repo_fts MATCH 'keyword';
```

- SQLite 내장 기능, 추가 패키지 불필요
- LIKE 대비 10-100배 빠른 전문 검색

**파일:** `backend/app/database.py`, `backend/app/api/routes.py`

---

## 7. 크롤러 개선

### 7.1 [HIGH] 동시 워커 (asyncio 기반)

**현재:** 단일 워커, 순차 처리

**개선:** asyncio.Semaphore로 동시성 제어
```python
SEM = asyncio.Semaphore(3)  # 동시 3개

async def _worker(self):
    while self._running:
        task = await self._queue.get()
        async with SEM:
            await self._process(task)

# 워커 3개 시작
self._workers = [asyncio.create_task(self._worker()) for _ in range(3)]
```

- GitHub API rate limit (5000/h 인증) 고려하여 3개 적정
- 외부 패키지 불필요

**파일:** `backend/app/crawler/engine.py` (또는 `crawler.py`)

### 7.2 [HIGH] 실패 태스크 자동 재시도

**현재:** 실패 시 `failed` 상태로 종료

**개선:**
```python
MAX_RETRIES = 3

async def _process(self, task):
    for attempt in range(MAX_RETRIES):
        try:
            await self._execute(task)
            return
        except RateLimitError:
            await asyncio.sleep(60 * (attempt + 1))  # 지수 백오프
        except NotFoundError:
            task.status = 'skipped'
            return
        except Exception:
            if attempt == MAX_RETRIES - 1:
                task.status = 'failed'
            else:
                await asyncio.sleep(5 * (2 ** attempt))
```

**파일:** `backend/app/crawler/engine.py`

### 7.3 [MEDIUM] 서버 재시작 시 태스크 복구

**현재:** `running` 상태 태스크가 서버 재시작 시 영구 중단

**개선:** 시작 시 orphaned 태스크 복구
```python
# lifespan 또는 crawler init에서
await db.execute(
    update(CrawlTask)
    .where(CrawlTask.status == 'running')
    .values(status='pending')
)
```

**파일:** `backend/app/crawler/engine.py`, `backend/app/main.py`

---

## 8. 신규 기능 (현재 스택으로 구현 가능)

### 8.1 [HIGH] 그래프 데이터 내보내기

```javascript
// JSON 내보내기
const exportJSON = () => {
    const data = { nodes: graphData.nodes, links: graphData.links };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    saveAs(blob, 'graph-data.json');
};

// CSV 내보내기
const exportCSV = () => {
    const header = 'id,type,label,stars,language\n';
    const rows = graphData.nodes.map(n => 
        `${n.id},${n.type},${n.label},${n.stars || ''},${n.language || ''}`
    ).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    saveAs(blob, 'graph-nodes.csv');
};
```

**파일:** `frontend/src/pages/GraphPage.jsx`

### 8.2 [MEDIUM] 경로 찾기 (BFS)

두 노드 간 최단 경로를 시각적으로 표시

```python
# Backend: /api/graph/path?from=repo:1&to=author:5
@router.get("/graph/path")
async def find_path(from_id: str, to_id: str, db = Depends(get_db)):
    # BFS on graph edges
    # 이미 GraphBuilder에 그래프 구조가 있으므로 활용
    ...
```

```javascript
// Frontend: 경로 노드/엣지를 다른 색으로 하이라이트
pathNodes.forEach(id => highlightNode(id, 0xff4444));
```

**파일:** `backend/app/api/routes.py`, `frontend/src/components/GraphView3DLarge.jsx`

### 8.3 [LOW] 다크/라이트 테마 전환

```css
:root {
    --bg-primary: #0a0a0f;
    --text-primary: #e0e0e0;
    /* ... */
}
[data-theme="light"] {
    --bg-primary: #ffffff;
    --text-primary: #1a1a1a;
    /* ... */
}
```

```javascript
const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    setTheme(next);
};
```

**파일:** `frontend/src/index.css`, `frontend/src/App.jsx`

---

## 구현 우선순위 요약

### 즉시 (1-2일)

| # | 항목 | 난이도 | 효과 |
|---|------|--------|------|
| 1 | 비밀번호 안전 비교 (`hmac.compare_digest`) | ★☆☆ | 보안 |
| 2 | 간이 Rate Limiting 미들웨어 | ★★☆ | 보안 |
| 3 | CORS 도메인 제한 | ★☆☆ | 보안 |
| 4 | HTTP 상태 코드 정상화 | ★☆☆ | 품질 |
| 5 | 헬스체크 엔드포인트 | ★☆☆ | 운영 |

### 단기 (3-5일)

| # | 항목 | 난이도 | 효과 |
|---|------|--------|------|
| 6 | N+1 쿼리 수정 | ★★☆ | 성능 10x |
| 7 | Three.js 리소스 정리 강화 | ★★☆ | 메모리 |
| 8 | Error Boundary 추가 | ★☆☆ | 안정성 |
| 9 | 라벨 LOD | ★★☆ | 렌더링 성능 |
| 10 | Worker Transferable Objects | ★★☆ | 통신 성능 |
| 11 | 크롤러 동시 워커 (3개) | ★★☆ | 크롤링 3x |
| 12 | 실패 태스크 자동 재시도 | ★★☆ | 안정성 |

### 중기 (1-2주)

| # | 항목 | 난이도 | 효과 |
|---|------|--------|------|
| 13 | 필터 URL 동기화 | ★★☆ | UX |
| 14 | 검색 → 카메라 이동 | ★★☆ | UX |
| 15 | 키보드 단축키 | ★★☆ | UX |
| 16 | 조작 안내 오버레이 | ★☆☆ | UX |
| 17 | 로깅 시스템 (`logging`) | ★☆☆ | 운영 |
| 18 | DB 인덱스 추가 | ★☆☆ | 성능 |
| 19 | SQLite FTS5 검색 | ★★★ | 검색 성능 |
| 20 | AdminPage 컴포넌트 분리 | ★★☆ | 유지보수 |
| 21 | 데이터 내보내기 | ★★☆ | 기능 |
| 22 | 우클릭 컨텍스트 메뉴 | ★★★ | UX |
| 23 | 경로 찾기 | ★★★ | 기능 |

---

> 모든 항목은 현재 의존성(SQLite, FastAPI, React, Three.js)만으로 구현 가능합니다.
> 항목별로 독립적이며, 어떤 순서로든 진행할 수 있습니다.
