# Istrom Inventory Management System

Professional Construction Project Management - Materials and Labour Inventory with multi-project support.

**Tech stack:** FastAPI (backend) + React (frontend). Database: SQLite (default) or PostgreSQL.

## Quick Start

### 1. Install Dependencies

```bash
# Backend
pip install -r backend/requirements.txt

# Frontend
cd frontend && npm install
```

### 2. Initialize Database

```bash
cd backend && python schema_init.py
```

### 3. Run the Application

**Option A: Run both together**
```bash
npm run dev
```

**Option B: Run separately**
```bash
# Terminal 1 - Backend (port 8000)
cd backend && uvicorn api.main:app --reload --host 0.0.0.0 --port 8000

# Terminal 2 - Frontend (port 5173)
cd frontend && npm run dev
```

### 4. Access the App

- **URL:** http://localhost:5173
- **Admin code:** `Istrom2026`
- **Default user code:** `user123`

## Environment Variables

- `DATABASE_URL` - PostgreSQL connection string (optional, defaults to SQLite `istrominventory.db`)
- `JWT_SECRET` - Secret for JWT tokens (set in production)
- `VITE_API_URL` - Frontend API base URL (defaults to `/api` for dev proxy)

## Project Structure

```
backend/
  api/
    main.py          # FastAPI app
    routes/          # API routes
    schemas.py       # Pydantic models
    dependencies.py  # Auth, DB
  db.py
  models.py
  schema_init.py
  constants.py

frontend/
  src/
    api.js          # API client
    contexts/       # Auth context
    components/    # Layout, etc.
    pages/         # Tab pages
```

## Features

- **Access Code Login** - Admin (global) and Project Site (per-site) codes
- **Manual Entry** - Add items with budget, section, building type
- **Inventory** - View, edit, delete items
- **Make Request** - Submit requests with approval workflow
- **Review & History** - Approve/reject, bulk actions, deleted logs
- **Budget Summary** - By building type and budget
- **Actuals** - Budget vs actual comparison
- **Admin Settings** - Access codes, project sites, access logs
- **Notifications** - Approvals, rejections, submissions
