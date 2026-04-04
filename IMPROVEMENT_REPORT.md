# GitHub AI Network - 종합 개선 보고서

> 전체 레포지토리 심층 분석 및 개선 방향 (2026-04-04)

---

## 목차

1. [보안 (Security)](#1-보안-security)
2. [백엔드 아키텍처 (Backend Architecture)](#2-백엔드-아키텍처-backend-architecture)
3. [데이터베이스 (Database)](#3-데이터베이스-database)
4. [크롤러 (Crawler)](#4-크롤러-crawler)
5. [API 설계 (API Design)](#5-api-설계-api-design)
6. [프론트엔드 아키텍처 (Frontend Architecture)](#6-프론트엔드-아키텍처-frontend-architecture)
7. [3D 그래프 렌더링 (3D Graph Rendering)](#7-3d-그래프-렌더링-3d-graph-rendering)
8. [UX/UI 개선 (UX/UI)](#8-uxui-개선-uxui)
9. [성능 최적화 (Performance)](#9-성능-최적화-performance)
10. [인프라 및 배포 (Infrastructure)](#10-인프라-및-배포-infrastructure)
11. [테스트 및 품질 (Testing & Quality)](#11-테스트-및-품질-testing--quality)
12. [신규 기능 제안 (New Features)](#12-신규-기능-제안-new-features)
13. [구현 우선순위 (Priority Matrix)](#13-구현-우선순위-priority-matrix)

---

## 1. 보안 (Security)

### 1.1 [CRITICAL] Admin 비밀번호 평문 저장

**현재 상태:**
```python
# backend/app/api/admin.py
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "admin1234")
```

- 비밀번호가 환경변수 미설정 시 하드코딩된 기본값 사용
- 비교 시 평문 문자열 비교 (`password == ADMIN_PASSWORD`)
- 타이밍 공격에 취약

**개선 방향:**
- `bcrypt` 또는 `passlib`를 사용한 해시 비교
- `hmac.compare_digest()`로 타이밍 안전 비교
- 기본 비밀번호 제거 — 환경변수 미설정 시 서버 시작 거부
- 비밀번호 최소 복잡도 요구사항 추가

### 1.2 [CRITICAL] 인증 토큰 인메모리 저장

**현재 상태:**
```python
# backend/app/api/admin.py
active_tokens: dict[str, float] = {}
```

- 서버 재시작 시 모든 세션 소멸
- 토큰이 UUID v4 기반이나 만료 정리가 로그인 시점에만 발생
- 다중 프로세스 환경에서 토큰 공유 불가

**개선 방향:**
- Redis 기반 세션 저장소 또는 JWT 토큰 전환
- 토큰 만료를 background task로 주기적 정리
- Refresh token 패턴 도입
- Rate limiting on login endpoint (brute-force 방지)

### 1.3 [HIGH] 공개 API Rate Limiting 부재

**현재 상태:**
- `/api/graph`, `/api/search`, `/api/stats` 등 공개 엔드포인트에 rate limiting 없음
- 대량 요청으로 DB 과부하 가능

**개선 방향:**
- `slowapi` 또는 미들웨어 기반 rate limiting
- IP 기반 + 엔드포인트별 차등 제한
- `/api/graph`는 특히 무거우므로 분당 10-20회 제한 권장

### 1.4 [MEDIUM] CORS 설정

**현재 상태:**
```python
# backend/app/main.py
allow_origins=["*"]
```

- 모든 도메인에서 API 접근 가능
- 프로덕션 환경에서는 특정 도메인만 허용해야 함

**개선 방향:**
- 환경변수로 허용 도메인 목록 관리
- 개발/프로덕션 환경별 분리

---

## 2. 백엔드 아키텍처 (Backend Architecture)

### 2.1 그래프 빌더 N+1 쿼리 문제

**현재 상태:**
```python
# backend/app/graph/builder.py
# 레포 조회 → 각 레포별 토픽 조회 → 각 레포별 기여자 조회
repos = await db.execute(select(Repository)...)
for repo in repos:
    topics = await db.execute(select(Topic).join(RepoTopic)...)  # N+1
```

- 300개 레포 로드 시 최소 600+ 쿼리 발생 가능
- 응답 시간이 데이터 규모에 비례하여 급격히 증가

**개선 방향:**
- `selectinload` / `joinedload`로 eager loading 적용
- 단일 조인 쿼리로 레포+토픽+기여자 한번에 로드
- 또는 materialized view / 캐시 테이블로 사전 집계

### 2.2 캐시 시스템 한계

**현재 상태:**
```python
# backend/app/main.py — LRU cache
class LRUCache:
    def __init__(self, capacity=64): ...
```

- 메모리 기반 LRU 캐시, 용량 64개
- 캐시 무효화 전략 없음 (데이터 변경 후에도 이전 결과 반환)
- 캐시 크기 제한이 메모리가 아닌 항목 수 기준

**개선 방향:**
- Redis 캐시 도입 (TTL 기반 자동 만료)
- 크롤링 세션 완료 시 관련 캐시 무효화
- 캐시 키에 데이터 버전 포함
- 응답 크기 기반 캐시 제한 (항목 수 대신)

### 2.3 에러 핸들링 일관성

**현재 상태:**
- 일부 엔드포인트는 `{"error": "message"}` 반환
- HTTP 상태 코드를 적절히 사용하지 않음 (항상 200)
- 글로벌 예외 핸들러 미설정

**개선 방향:**
- `HTTPException` 사용으로 적절한 상태 코드 반환 (404, 400, 422 등)
- 글로벌 예외 핸들러로 일관된 에러 응답 포맷
- 구조화된 에러 로깅 (현재 print 기반)

---

## 3. 데이터베이스 (Database)

### 3.1 [HIGH] SQLite 프로덕션 사용

**현재 상태:**
```python
# backend/app/database.py
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./github_network.db")
```

- SQLite는 동시 쓰기에 제한 (write lock)
- 크롤러와 API 서버가 동시 접근 시 충돌 가능
- 대용량 데이터 (10만+ 노드) 시 성능 저하

**개선 방향:**
- PostgreSQL (asyncpg) 전환
- Connection pooling 설정 (min/max connections)
- Read replica 분리 (API 읽기 / 크롤러 쓰기)

### 3.2 마이그레이션 도구 부재

**현재 상태:**
- `Base.metadata.create_all()` 으로 테이블 생성
- 스키마 변경 시 수동 관리
- 마이그레이션 히스토리 없음

**개선 방향:**
- Alembic 도입
- 자동 마이그레이션 생성 + 버전 관리
- CI/CD 파이프라인에 마이그레이션 통합

### 3.3 인덱스 최적화

**현재 상태:**
- 기본 PK 인덱스만 존재
- `Repository.full_name`, `Author.login` 등 검색 필드에 인덱스 없음
- `RepoContributor` 복합 인덱스 없음

**개선 방향:**
```python
# 추가 필요 인덱스
Index('ix_repo_stars', Repository.stars.desc())
Index('ix_repo_fullname', Repository.full_name)
Index('ix_repo_owner', Repository.owner_id)
Index('ix_author_login', Author.login)
Index('ix_contrib_repo_author', RepoContributor.repository_id, RepoContributor.author_id, unique=True)
Index('ix_contrib_author', RepoContributor.author_id)
```

### 3.4 데이터 무결성

**현재 상태:**
- `fork_source_id` 외래키 제약 없이 nullable integer
- 중복 데이터 방지가 애플리케이션 레벨에서만 처리
- `CrawlTask.status` 값 제한 없음 (자유 문자열)

**개선 방향:**
- 적절한 외래키 + UNIQUE 제약 조건 추가
- Enum 타입으로 상태값 제한
- CHECK 제약 조건 활용

---

## 4. 크롤러 (Crawler)

### 4.1 [HIGH] 단일 워커 병목

**현재 상태:**
```python
# backend/app/crawler/engine.py
async def _worker(self):  # 단일 워커
    while self._running:
        task = await self._queue.get()
        await self._process(task)
```

- 한 번에 하나의 태스크만 처리
- GitHub API 응답 대기 시간 동안 유휴 상태
- 대규모 크롤링 시 매우 느림

**개선 방향:**
- `asyncio.Semaphore` 기반 동시 워커 (3-5개)
- GitHub API rate limit에 맞춘 adaptive concurrency
- 워커별 독립적인 에러 핸들링

### 4.2 GitHub API Rate Limit 관리

**현재 상태:**
- Rate limit 초과 시 단순 sleep
- 남은 quota 확인 없이 요청 발송
- 인증/비인증 토큰 전환 로직 없음

**개선 방향:**
- `X-RateLimit-Remaining` 헤더 모니터링
- Quota 소진 전 선제적 throttling
- 다중 GitHub 토큰 로테이션 지원
- Rate limit 상태를 Admin UI에 실시간 표시

### 4.3 크롤링 깊이 제어

**현재 상태:**
- BFS 기반 확장이지만 깊이 제한이 느슨
- 인기 레포에서 수천 개의 기여자 태스크 생성 가능
- 우선순위 큐가 없어 중요도와 무관하게 순차 처리

**개선 방향:**
- 우선순위 큐 도입 (stars, followers 기반 가중치)
- 깊이별 확장 비율 제한 (depth 1: 전체, depth 2: 상위 20%, depth 3: 상위 5%)
- 크롤링 예산 (budget) 시스템 — 세션당 최대 노드 수 제한

### 4.4 재시도 및 복구

**현재 상태:**
- 실패한 태스크는 `failed` 상태로 기록
- 자동 재시도 메커니즘 없음
- 서버 재시작 시 진행 중 태스크 상태 불명확

**개선 방향:**
- 지수 백오프(exponential backoff) 재시도 (최대 3회)
- 실패 사유별 분류 (rate_limit, not_found, server_error)
- 서버 시작 시 `running` 상태 태스크를 `pending`으로 복구

---

## 5. API 설계 (API Design)

### 5.1 응답 페이지네이션

**현재 상태:**
- `/api/graph`는 `limit` 파라미터만 존재, offset/cursor 없음
- `/api/search`도 페이지네이션 미지원
- 대량 데이터 요청 시 메모리 부담

**개선 방향:**
- Cursor 기반 페이지네이션 (`after` 파라미터)
- 응답에 `has_next`, `total_count`, `next_cursor` 포함
- 기본 응답 크기 제한 강화

### 5.2 API 버전 관리

**현재 상태:**
- `/api/` prefix만 사용, 버전 정보 없음
- API 변경 시 하위 호환성 보장 방법 없음

**개선 방향:**
- `/api/v1/` 경로 도입
- Breaking change 시 새 버전 경로 추가
- Deprecation 헤더 지원

### 5.3 WebSocket 실시간 업데이트

**현재 상태:**
- Admin 페이지에서 크롤러 상태를 polling으로 확인 (5초 간격)
- 네트워크 오버헤드 + 지연

**개선 방향:**
- WebSocket 엔드포인트 추가 (`/ws/crawler/status`)
- 크롤러 진행률, 새 노드 발견, 에러 등 실시간 푸시
- 메인 그래프에서도 새 노드 실시간 추가 가능

### 5.4 GraphQL 도입 고려

**현재 상태:**
- REST API에서 노드 상세 조회 시 모든 필드를 항상 반환
- 클라이언트가 필요한 필드만 선택 불가
- 관계 탐색 시 여러 엔드포인트 호출 필요

**개선 방향:**
- Strawberry (Python GraphQL) 도입 검토
- 그래프 데이터 특성상 GraphQL이 자연스러운 매핑
- 프론트엔드에서 필요한 필드만 요청하여 대역폭 절약

---

## 6. 프론트엔드 아키텍처 (Frontend Architecture)

### 6.1 [HIGH] AdminPage 컴포넌트 비대화

**현재 상태:**
- `AdminPage.jsx`: 약 700줄, 단일 파일에 모든 로직
- 세션 관리, 크롤러 제어, 태스크 주입, 상태 모니터링 모두 포함
- 상태 변수 20개 이상

**개선 방향:**
- 기능별 컴포넌트 분리:
  - `SessionManager` — 세션 목록/생성/삭제
  - `CrawlerControl` — 시작/중지/상태
  - `TaskInjector` — 태스크 수동 추가
  - `CrawlerMonitor` — 실시간 진행률/로그
- Custom hooks 추출: `useSession`, `useCrawler`, `useTaskInjection`

### 6.2 상태 관리

**현재 상태:**
- 모든 상태가 `useState`로 개별 관리
- Props drilling 다수 (GraphPage → GraphView3DLarge → NodeDetailModal)
- 전역 상태 관리 도구 없음

**개선 방향:**
- Zustand 또는 Context API로 그래프 상태 관리
  - `graphStore`: nodes, links, selectedNode, filters
  - `crawlerStore`: sessions, status, tasks
- Props drilling 감소 및 상태 접근 단순화

### 6.3 TypeScript 전환

**현재 상태:**
- 전체 프론트엔드가 JavaScript (`.jsx`)
- 타입 안전성 없음 — API 응답 구조 변경 시 런타임 에러

**개선 방향:**
- 점진적 TypeScript 전환 (`tsconfig.json` → `allowJs: true`)
- API 응답 타입 정의 (`types/api.ts`)
- 컴포넌트 Props 인터페이스 정의
- 주요 유틸리티부터 시작하여 점진적 전환

### 6.4 에러 바운더리

**현재 상태:**
- 컴포넌트 에러 시 전체 앱 크래시
- 3D 그래프 WebGL 에러 시 복구 불가

**개선 방향:**
- React Error Boundary 추가
- 그래프 렌더링 실패 시 fallback UI (2D 그래프 또는 목록 뷰)
- 에러 발생 시 자동 리포팅 (Sentry 등)

---

## 7. 3D 그래프 렌더링 (3D Graph Rendering)

### 7.1 [HIGH] 메모리 누수

**현재 상태:**
```javascript
// frontend/src/components/GraphView3DLarge.jsx
// cleanup에서 Three.js 리소스 해제 불완전
return () => {
    cancelAnimationFrame(rafRef.current);
    renderer.dispose();
    // geometry, material, texture 개별 dispose 누락
};
```

- `InstancedMesh`의 geometry/material이 명시적으로 dispose되지 않음
- Bloom pass의 render targets 미해제
- 반복적인 모달 열기/닫기 시 GPU 메모리 축적

**개선 방향:**
- cleanup 함수에서 모든 Three.js 리소스 명시적 dispose:
  ```javascript
  geometry.dispose();
  material.dispose();
  edgeGeometry.dispose();
  edgeMaterial.dispose();
  bloomComposer.passes.forEach(p => p.dispose?.());
  renderer.forceContextLoss();
  ```
- `WeakRef` 또는 리소스 추적 패턴 도입
- 메모리 사용량 모니터링 유틸리티

### 7.2 라벨 업데이트 성능

**현재 상태:**
```javascript
// Effect 4b: live update — 매 워커 메시지마다 라벨 업데이트
labelGroup.children.forEach(sprite => {
    // 모든 라벨의 위치 + 스케일 업데이트
});
```

- 수천 개 라벨의 매 프레임 업데이트는 GC 압박
- `SpriteMaterial` + `CanvasTexture` 조합이 무거움

**개선 방향:**
- 카메라 거리 기반 LOD (Level of Detail) — 먼 라벨은 숨기기
- SDF (Signed Distance Field) 텍스트 렌더링 검토
- 라벨 풀링 — 화면에 보이는 것만 활성화
- `troika-three-text` 라이브러리 검토 (GPU 텍스트 렌더링)

### 7.3 WebGL 컨텍스트 관리

**현재 상태:**
- 메인 그래프 + 모달 서브그래프 = 동시에 2개 WebGL 컨텍스트
- 브라우저별 WebGL 컨텍스트 제한 (보통 8-16개)
- 컨텍스트 손실 시 복구 로직 없음

**개선 방향:**
- `renderer.context.canvas.addEventListener('webglcontextlost', ...)` 핸들러
- 모달 닫힐 때 즉시 컨텍스트 해제
- 단일 렌더러 공유 검토 (viewport 분할)

### 7.4 대규모 그래프 최적화

**현재 상태:**
- 10만+ 노드에서 프레임 드롭 가능성
- 모든 노드가 항상 렌더링됨 (frustum culling만)
- 엣지가 `BufferGeometry` 단일 메시로 처리되나 업데이트 비용 높음

**개선 방향:**
- 시맨틱 줌: 줌 레벨에 따라 표시할 노드 계층 변경
  - 멀리: 클러스터 대표 노드만
  - 중간: 주요 노드 (stars > threshold)
  - 가까이: 모든 노드
- Octree 기반 공간 분할로 레이캐스팅 최적화
- GPU 파티클 시스템으로 초대규모 노드 처리

---

## 8. UX/UI 개선 (UX/UI)

### 8.1 [HIGH] 모바일 대응

**현재 상태:**
- 3D 그래프가 모바일에서 거의 사용 불가
- 터치 인터랙션 미지원 (핀치 줌, 스와이프 등)
- Admin 페이지 레이아웃 모바일 미대응

**개선 방향:**
- 모바일 감지 → 경량 2D 그래프 자동 전환
- 터치 제스처 지원 (pinch-zoom, pan, tap/long-press)
- 반응형 레이아웃 (CSS Grid/Flexbox 미디어 쿼리)
- 모달 모바일 최적화 (전체화면 전환)

### 8.2 필터 상태 유지

**현재 상태:**
- 페이지 새로고침 시 모든 필터 초기화
- 언어 필터, 노드 타입, 검색어 등 휘발성

**개선 방향:**
- URL 쿼리 파라미터로 필터 상태 반영 (`?lang=Python&types=repo,author&search=ai`)
- `localStorage`에 최근 필터 설정 저장
- 필터 프리셋 저장/불러오기 기능

### 8.3 검색 UX 강화

**현재 상태:**
- 단순 LIKE 검색, 타이핑 중 debounce만 적용
- 검색 결과에서 노드로 이동 시 3D 공간에서 해당 노드 찾기 어려움
- 검색 히스토리 없음

**개선 방향:**
- 검색 결과 선택 시 카메라가 해당 노드로 자동 이동 (fly-to animation)
- 검색 하이라이트 — 결과 노드만 강조, 나머지 dimming
- Full-text search (PostgreSQL tsvector) 또는 ElasticSearch
- 검색 자동완성 (debounced suggestions)
- 최근 검색 히스토리 표시

### 8.4 노드 컨텍스트 메뉴

**현재 상태:**
- 노드 클릭: 선택 + 정보 표시
- 노드 더블클릭: 상세 모달
- 우클릭: 기본 브라우저 메뉴

**개선 방향:**
- 우클릭 컨텍스트 메뉴:
  - "GitHub에서 열기"
  - "이 노드부터 탐색"
  - "연결된 노드만 보기"
  - "숨기기"
  - "경로 찾기 시작점으로 설정"

### 8.5 접근성 (Accessibility)

**현재 상태:**
- 키보드 네비게이션 미지원
- 스크린 리더 미대응
- 색상 대비 부족 (어두운 배경 + 밝은 텍스트)
- ARIA 속성 없음

**개선 방향:**
- 3D 그래프에 대한 대체 뷰 (테이블/리스트)
- 모달과 UI 요소에 ARIA 속성 추가
- Tab 키 네비게이션 지원
- 고대비 모드 옵션

### 8.6 온보딩 및 도움말

**현재 상태:**
- 첫 방문 시 가이드 없음
- 3D 조작 방법 (회전, 줌, 클릭, 더블클릭) 설명 없음
- 기능 발견성 낮음

**개선 방향:**
- 첫 방문 시 인터랙티브 투어 (react-joyride 등)
- 조작 안내 오버레이 (단축키 포함)
- 툴팁으로 주요 기능 설명

---

## 9. 성능 최적화 (Performance)

### 9.1 번들 크기 최적화

**현재 상태:**
- Three.js 전체 import (`import * as THREE from 'three'`)
- 사용하지 않는 모듈도 번들에 포함
- 코드 스플리팅 부분 적용 (GraphView3DLarge만 lazy)

**개선 방향:**
- Three.js 트리셰이킹 (`import { Scene, WebGLRenderer } from 'three'`)
- 동적 import 확대 (AdminPage, NodeDetailModal)
- 번들 분석 (`rollup-plugin-visualizer`) 후 최적화
- 외부 라이브러리 CDN 활용 검토

### 9.2 초기 로딩 속도

**현재 상태:**
- 페이지 로드 → API 호출 → 그래프 데이터 수신 → 워커 시작 → 렌더링
- 이 과정이 순차적으로 진행
- 큰 그래프 데이터 전송 시 지연

**개선 방향:**
- 서버 측 그래프 데이터 압축 (gzip/brotli 미들웨어)
- 점진적 로딩: 먼저 주요 노드(top 50) 표시 → 나머지 스트리밍
- 이전 세션의 그래프를 `IndexedDB`에 캐싱
- Skeleton UI로 로딩 상태 표시

### 9.3 Web Worker 최적화

**현재 상태:**
```javascript
// layout.worker.js
sim.on('tick', () => {
    const pos = new Float32Array(n * 3);
    // 매 틱마다 전체 위치 배열 복사 + postMessage
});
```

- 매 시뮬레이션 틱마다 전체 노드 위치 전송
- `postMessage`의 structured clone 비용
- 대규모 그래프에서 병목

**개선 방향:**
- `SharedArrayBuffer` + `Atomics`로 zero-copy 위치 공유
- 또는 `Transferable` 사용 (`postMessage(buffer, [buffer])`)
- 틱 간격 조절 — 수렴 중에는 매 틱, 안정화 후에는 간헐적 업데이트
- 델타 인코딩 — 변경된 노드 위치만 전송

### 9.4 API 응답 최적화

**현재 상태:**
- `/api/graph` 응답에 모든 노드의 전체 필드 포함
- compact 모드 있으나 기본 비활성

**개선 방향:**
- compact 모드를 기본값으로 변경
- 필드 선택 파라미터 (`fields=id,label,type,val`)
- ETag / If-None-Match 캐싱
- 응답 압축 미들웨어 (현재 미확인)

---

## 10. 인프라 및 배포 (Infrastructure)

### 10.1 환경 설정 관리

**현재 상태:**
- `.env` 파일 직접 관리
- 환경별 설정 분리 미흡
- 민감 정보(GitHub 토큰, Admin 비밀번호)가 같은 파일에

**개선 방향:**
- `pydantic-settings`로 설정 모델화 (타입 검증)
- 환경별 설정 파일: `.env.development`, `.env.production`
- Secret management: Docker Secrets 또는 Vault

### 10.2 로깅 시스템

**현재 상태:**
- `print()` 기반 로깅
- 구조화된 로그 포맷 없음
- 로그 레벨 구분 없음

**개선 방향:**
- `structlog` 또는 `loguru` 도입
- JSON 형식 로그 출력 (ELK 스택 연동 용이)
- 요청별 trace ID (correlation ID)
- 크롤러 작업 로그와 API 로그 분리

### 10.3 헬스체크 및 모니터링

**현재 상태:**
- `/api/stats`만 존재 (DB 통계)
- 서버 상태, DB 연결 상태, 워커 상태 확인 불가
- 메트릭 수집 없음

**개선 방향:**
- `/health` 엔드포인트 (DB 연결, 워커 상태, 메모리 사용량)
- Prometheus 메트릭 노출 (`/metrics`)
  - API 응답 시간 히스토그램
  - 크롤러 태스크 처리율
  - DB 커넥션 풀 상태
  - 그래프 노드/엣지 수
- Grafana 대시보드 구성

### 10.4 Docker 및 컨테이너화

**현재 상태:**
- Docker 설정 존재 여부 미확인
- 개발/프로덕션 환경 차이 가능

**개선 방향:**
- Multi-stage Dockerfile (빌드 / 프로덕션 분리)
- `docker-compose.yml`: 앱 + PostgreSQL + Redis
- 프로덕션: Gunicorn + Uvicorn 워커 (현재 단일 Uvicorn)

---

## 11. 테스트 및 품질 (Testing & Quality)

### 11.1 [HIGH] 테스트 부재

**현재 상태:**
- 유닛 테스트 없음
- 통합 테스트 없음
- E2E 테스트 없음

**개선 방향:**

**Backend 테스트:**
- `pytest` + `pytest-asyncio`
- API 엔드포인트 테스트 (TestClient)
- 크롤러 로직 유닛 테스트 (GitHub API mock)
- 그래프 빌더 테스트 (기대 노드/엣지 구조 검증)

**Frontend 테스트:**
- `vitest` + `@testing-library/react`
- 컴포넌트 렌더링 테스트
- 모달 네비게이션 로직 테스트
- API 호출 mock 테스트

**E2E 테스트:**
- Playwright 또는 Cypress
- 주요 사용자 플로우: 검색 → 노드 선택 → 모달 → 네비게이션
- Admin 로그인 → 세션 생성 → 크롤링 시작

### 11.2 코드 품질 도구

**현재 상태:**
- Linter/Formatter 설정 미확인
- Pre-commit hooks 없음
- CI/CD 파이프라인 없음

**개선 방향:**
- Backend: `ruff` (lint + format), `mypy` (type checking)
- Frontend: `eslint` + `prettier`, `typescript` (점진적)
- Pre-commit: `husky` + `lint-staged`
- GitHub Actions CI: lint → test → build → deploy

---

## 12. 신규 기능 제안 (New Features)

### 12.1 경로 찾기 (Path Finding)

두 노드 간의 최단 경로를 시각화

```
Node A ──→ Contributor X ──→ Repo Y ──→ Author B
```

- BFS/Dijkstra 기반 최단 경로 탐색
- 경로 상의 노드/엣지 하이라이트
- "N degrees of separation" 표시

### 12.2 그래프 스냅샷 및 공유

- 현재 뷰를 이미지로 캡처 (renderer.toDataURL)
- 필터 + 카메라 위치를 URL로 공유
- 특정 탐색 경로를 "Story"로 저장/공유

### 12.3 시간축 탐색 (Timeline)

- 크롤링 세션별 그래프 변화 시각화
- 슬라이더로 시간대 이동
- 새로 추가된 노드/엣지 하이라이트

### 12.4 클러스터 분석

- 커뮤니티 탐지 알고리즘 (Louvain, Label Propagation)
- 자동 클러스터 색상 분류
- 클러스터 요약 정보 (주요 언어, 토픽, 핵심 인물)

### 12.5 추천 시스템

- "이 레포를 보는 사람들이 함께 보는 레포"
- 기여자 기반 유사 레포 추천
- 토픽 기반 관련 레포 추천

### 12.6 데이터 내보내기

- 그래프 데이터 JSON/CSV 내보내기
- 선택된 노드들의 보고서 생성
- GEXF 포맷 (Gephi 호환) 내보내기

### 12.7 다크/라이트 테마 전환

- 현재 다크 테마 고정
- 사용자 시스템 설정 감지 (`prefers-color-scheme`)
- 테마 전환 토글

### 12.8 알림 시스템

- 크롤링 완료 알림
- 관심 레포/저자 변경 감지
- 브라우저 Notification API 활용

---

## 13. 구현 우선순위 (Priority Matrix)

### Tier 1: 즉시 수행 (보안 + 안정성)

| # | 항목 | 영향도 | 복잡도 | 근거 |
|---|------|--------|--------|------|
| 1 | Admin 비밀번호 해시화 | ★★★★★ | 낮음 | 보안 취약점 |
| 2 | Rate Limiting 추가 | ★★★★★ | 낮음 | DoS 방지 |
| 3 | CORS 도메인 제한 | ★★★★☆ | 낮음 | 보안 기본 |
| 4 | Three.js 메모리 누수 수정 | ★★★★☆ | 중간 | 사용성 |
| 5 | 에러 핸들링 일관화 | ★★★★☆ | 중간 | 안정성 |

### Tier 2: 단기 (1-2주) — 성능 + 품질

| # | 항목 | 영향도 | 복잡도 | 근거 |
|---|------|--------|--------|------|
| 6 | N+1 쿼리 수정 | ★★★★☆ | 중간 | 응답 속도 |
| 7 | 기본 테스트 구축 | ★★★★☆ | 중간 | 코드 품질 |
| 8 | 로깅 시스템 도입 | ★★★☆☆ | 낮음 | 운영 |
| 9 | 헬스체크 엔드포인트 | ★★★☆☆ | 낮음 | 모니터링 |
| 10 | 인덱스 최적화 | ★★★☆☆ | 낮음 | DB 성능 |

### Tier 3: 중기 (2-4주) — 아키텍처

| # | 항목 | 영향도 | 복잡도 | 근거 |
|---|------|--------|--------|------|
| 11 | PostgreSQL 전환 | ★★★★★ | 높음 | 확장성 |
| 12 | 다중 크롤러 워커 | ★★★★☆ | 중간 | 크롤링 속도 |
| 13 | AdminPage 리팩토링 | ★★★☆☆ | 중간 | 유지보수성 |
| 14 | 상태 관리 도입 | ★★★☆☆ | 중간 | 프론트 아키텍처 |
| 15 | TypeScript 전환 시작 | ★★★☆☆ | 중간 | 코드 품질 |

### Tier 4: 장기 (1-2개월) — 기능 확장

| # | 항목 | 영향도 | 복잡도 | 근거 |
|---|------|--------|--------|------|
| 16 | 모바일 대응 | ★★★★☆ | 높음 | 사용자 확대 |
| 17 | 경로 찾기 | ★★★★☆ | 중간 | 핵심 기능 |
| 18 | 클러스터 분석 | ★★★☆☆ | 높음 | 분석 가치 |
| 19 | 시간축 탐색 | ★★★☆☆ | 높음 | 차별화 |
| 20 | WebSocket 실시간 | ★★★☆☆ | 중간 | UX 개선 |

---

## 부록: 파일별 주요 변경 필요 사항

| 파일 | 주요 이슈 | 관련 섹션 |
|------|-----------|-----------|
| `backend/app/api/admin.py` | 비밀번호 해시, 토큰 저장소 | 1.1, 1.2 |
| `backend/app/api/routes.py` | 에러 핸들링, 페이지네이션 | 2.3, 5.1 |
| `backend/app/graph/builder.py` | N+1 쿼리, 캐시 | 2.1, 2.2 |
| `backend/app/database.py` | PostgreSQL 전환, 인덱스 | 3.1, 3.3 |
| `backend/app/models.py` | 인덱스, 제약조건, Enum | 3.3, 3.4 |
| `backend/app/crawler/engine.py` | 다중 워커, 재시도 | 4.1, 4.4 |
| `backend/app/main.py` | CORS, 로깅, 헬스체크 | 1.4, 10.2, 10.3 |
| `frontend/src/components/GraphView3DLarge.jsx` | 메모리 누수, LOD, WebGL | 7.1, 7.2, 7.3 |
| `frontend/src/pages/AdminPage.jsx` | 리팩토링, 컴포넌트 분리 | 6.1 |
| `frontend/src/pages/GraphPage.jsx` | 상태 관리, 필터 유지 | 6.2, 8.2 |
| `frontend/src/workers/layout.worker.js` | SharedArrayBuffer, 델타 | 9.3 |
| `frontend/src/index.css` | 반응형, 테마 | 8.1, 12.7 |

---

> 이 보고서는 현재 코드베이스의 심층 분석을 기반으로 작성되었으며, 각 개선 사항은 독립적으로 또는 함께 구현할 수 있습니다. Tier 1 항목부터 순차적으로 진행하는 것을 권장합니다.
