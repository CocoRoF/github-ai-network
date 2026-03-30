# GitHub AI Network

GitHub의 AI 관련 Repository들의 연결 관계를 Network Graph로 시각화하는 도구입니다.

크롤러가 지속적으로 GitHub를 탐색하여 AI 관련 저장소, 저자, 토픽 사이의 관계를 수집하고,
인터랙티브 네트워크 그래프로 표시합니다.

## Architecture

```
┌──────────┐     ┌───────────┐     ┌───────────┐
│  Nginx   │────▶│ Frontend  │     │ PostgreSQL│
│ (Proxy)  │     │ (React)   │     │   (DB)    │
│          │────▶│           │     │           │
│          │     └───────────┘     └─────┬─────┘
│          │────▶┌───────────┐           │
│          │     │ Backend   │───────────┘
│          │     │ (FastAPI) │───▶ GitHub API
│          │     │ + Crawler │
└──────────┘     └───────────┘
```

### Node Types
- **Author** (blue): GitHub 사용자/조직
- **Repository** (green): AI 관련 저장소
- **Topic** (orange): GitHub 토픽 태그

### Edge Types
- **owns**: Author → Repository (소유)
- **contributes**: Author → Repository (기여)
- **has_topic**: Repository → Topic (토픽 태그)

## Local Development

### Prerequisites
- Python 3.12+
- Node.js 20+
- Git

### Backend

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # macOS/Linux

pip install -r requirements.txt

# .env 파일 생성
cp ../.env.example .env
# GITHUB_TOKEN을 설정하세요

uvicorn app.main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend는 http://localhost:5173 에서 실행되며, API 요청은 자동으로 백엔드(localhost:8000)로 프록시됩니다.

### Usage

1. 백엔드와 프론트엔드를 모두 실행합니다
2. http://localhost:5173 에 접속합니다
3. 사이드바에서 **Start Crawler** 버튼을 클릭합니다
4. 크롤러가 데이터를 수집할 때까지 기다립니다
5. **⟳ Refresh** 버튼으로 그래프를 갱신합니다
6. 노드를 클릭하여 상세 정보를 확인하고, **Expand Connections**로 확장합니다

## Docker Deployment

```bash
# .env 파일 준비
cp .env.example .env
# GITHUB_TOKEN 설정

# 빌드 & 실행
docker compose up -d --build

# 로그 확인
docker compose logs -f backend
```

http://localhost (또는 설정된 PORT) 에서 접속 가능합니다.

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `GITHUB_TOKEN` | GitHub Personal Access Token | (required) |
| `CRAWLER_AUTO_START` | 서버 시작 시 크롤러 자동 실행 | `false` |
| `CRAWLER_DELAY` | API 요청 간 딜레이 (초) | `2.0` |
| `DATABASE_URL` | 데이터베이스 URL | SQLite (local) |
| `PORT` | Docker 외부 포트 | `80` |

## Tech Stack

- **Backend**: Python, FastAPI, SQLAlchemy (async), httpx
- **Frontend**: React 18, react-force-graph-2d, Vite
- **Database**: SQLite (dev) / PostgreSQL (prod)
- **Infrastructure**: Docker Compose, Nginx
