#!/bin/bash
set -e

mkdir -p storage/videos chroma_db

echo "[STARTUP] Launching Celery background worker (solo pool)..."
celery -A tasks.celery_app worker --loglevel=info --pool=solo &

echo "[STARTUP] Launching FastAPI gateway on port ${PORT:-8000}..."
exec uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1
