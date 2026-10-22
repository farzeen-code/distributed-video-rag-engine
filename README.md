# ⚡ DocAI & Video Intelligence Engine — Distributed Asynchronous RAG Pipeline

[![FastAPI](https://img.shields.io/badge/FastAPI-005571?style=for-the-badge&logo=fastapi)](https://fastapi.tiangolo.com)
[![Celery](https://img.shields.io/badge/Celery-37814A?style=for-the-badge&logo=celery&logoColor=white)](https://docs.celeryq.dev/)
[![Redis](https://img.shields.io/badge/Redis-DC382D?style=for-the-badge&logo=redis&logoColor=white)](https://redis.io/)
[![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://www.docker.com/)
[![Google Gemini](https://img.shields.io/badge/Google%20Gemini-8E75B2?style=for-the-badge&logo=google&logoColor=white)](https://ai.google.dev/)
[![ChromaDB](https://img.shields.io/badge/ChromaDB-FF6600?style=for-the-badge)](https://www.trychroma.com/)
[![Whisper](https://img.shields.io/badge/OpenAI%20Whisper-000000?style=for-the-badge&logo=openai&logoColor=white)](https://github.com/openai/whisper)

An enterprise-grade, microservice-decoupled **Multimodal Retrieval-Augmented Generation (RAG) Engine** capable of processing large PDF/DOCX documents as well as video uploads (`.mp4`, `.mkv`, `.webm`; see [Free-Tier Limits](#-free-tier-limits--what-video-lengths-actually-work)). Features an asynchronous event-driven worker queue (**Redis + Celery**), **FFmpeg** audio extraction, **INT8 quantized Whisper** speech-to-text transcription, **ChromaDB** vector storage, and **Gemini** temporal citation Q&A (`[MM:SS]`).

---

## 🌟 Key Architectural & Engineering Highlights

### 1. 🚀 Asynchronous Distributed Video Processing (Producer-Consumer Pattern)
Heavy video processing is completely decoupled from the web server thread to prevent API latency degradation or Out-of-Memory (OOM) crashes:
- **FastAPI Gateway (Producer)**: Accepts video uploads via chunked streaming (`shutil.copyfileobj`), writes to shared storage, and enqueues a lightweight JSON ticket to Redis in **$<200\text{ms}$**.
- **Redis Message Broker**: Manages queued jobs and stores task state metadata.
- **Celery Worker Pool (Consumer)**: Isolated background worker process that consumes tickets, executes FFmpeg audio extraction, and runs Whisper transcription without blocking web traffic.

### 2. 🎧 16kHz Mono Audio Extraction via FFmpeg Subprocess
Invokes an uncompressed PCM 16-bit WAV conversion (`-ar 16000 -ac 1 -vn`) via Python `subprocess`. Converting stereo/48kHz audio to 16kHz mono cuts raw audio data size by **50%** and eliminates CPU decoding overhead for the AI model.

### 3. 🧠 INT8 Quantized Local Speech Recognition (`faster-whisper`)
Utilizes `faster-whisper` on CTranslate2 CPU engine with **INT8 quantization**:
- Slashed RAM footprint by **70%** and boosted inference speed by **4x** compared to vanilla PyTorch Whisper.
- Auto-detects spoken languages (99 languages supported) with confidence scoring.
- Generates precise segment-level timestamps (`[01:15 - 01:45]`).

### 4. ⏱️ Temporal Citation Prompt Engineering
Video transcript segments are indexed into ChromaDB with explicit inline timestamp markers. Gemini is governed by strict citation rules:
> *"At [04:12 - 04:35], the speaker explains B-Trees..."*
Allows users to scrub directly to the exact moment in the video.

### 5. 🐳 Microservice Container Topology (Docker Compose)
Orchestrates 3 isolated containers over a private internal bridge network:
1. `rag_api_backend`: FastAPI Gateway
2. `rag_redis`: Redis 7 Broker
3. `rag_celery_worker`: Celery Worker with pre-cached Whisper & Chroma models
Uses volume mounts (`./storage`, `./chroma_db`) for shared host disk access.

---

## 🏗️ Architecture Diagram

```mermaid
graph TD
    Client([User / Postman / Frontend]) -->|POST /upload-video| API[FastAPI Gateway]
    API -->|1. Stream File| Disk[(Shared Storage: /storage/videos)]
    API -->|2. Enqueue Ticket| Redis[(Redis Broker & Result Backend)]
    API -->|3. Return task_id < 200ms| Client
    
    Redis -->|4. Pull Job| Worker[Celery Background Worker]
    Worker -->|5. Extract 16kHz Mono WAV| FFmpeg[FFmpeg Subprocess]
    FFmpeg --> Audio[Raw PCM WAV File]
    Audio --> Whisper[faster-whisper INT8 CPU Engine]
    
    Whisper -->|6. Timestamped Segments| Chunker[Timestamp Chunk Formatter]
    Chunker --> Embedder[ONNX Runtime: all-MiniLM-L6-v2]
    Embedder --> Chroma[(ChromaDB Persistent Vector Store)]
    
    Client -->|GET /tasks/task_id| API
    API -->|Poll Status: 15% -> 40% -> 100%| Redis
    
    Client -->|POST /query| API
    API --> Chroma
    Chroma -->|Retrieved Timestamped Chunks| Gemini[Google Gemini LLM Engine]
    Gemini -->|Answer with MM:SS Citations| Client
```

---

## 🛠️ Tech Stack

| Component | Technology | Purpose |
| :--- | :--- | :--- |
| **API Gateway** | **FastAPI** | High-performance asynchronous REST routing & streaming |
| **Task Queue & Broker** | **Redis** | In-memory message broker & task state store |
| **Distributed Worker** | **Celery** | Isolated background process execution |
| **Media Processing** | **FFmpeg** | Binary subprocess audio extraction (16kHz mono WAV) |
| **Speech Recognition** | **faster-whisper** | INT8 CTranslate2 CPU model for timestamped transcription |
| **Vector Database** | **ChromaDB** | Local persistent dense vector database |
| **Embedding Engine** | **ONNX Runtime** | `all-MiniLM-L6-v2` dense vectors (384-dimensional) |
| **LLM Inference** | **Google GenAI SDK** | Resilient Gemini Flash-Lite citation engine |
| **Containerization** | **Docker & Docker Compose** | Multi-container microservice orchestration |

---

## 📡 API Endpoints

### 1. Video Ingestion & Polling

#### `POST /upload-video`
Streams video file to storage and enqueues background processing.
- **Form Data**: `file` (`.mp4`, `.mkv`, `.mov`, `.webm`, `.avi`)
- **Response ($<200\text{ms}$)**:
```json
{
  "status": "queued",
  "task_id": "39ca2ffe-f378-427a-8593-d8f986697780",
  "filename": "lecture.mp4",
  "check_status_url": "/tasks/39ca2ffe-f378-427a-8593-d8f986697780"
}
```

#### `GET /tasks/{task_id}`
Polls Celery background worker progress.
- **Response**:
```json
{
  "task_id": "39ca2ffe-f378-427a-8593-d8f986697780",
  "state": "PROCESSING",
  "progress": 40,
  "step": "Transcribing audio with Whisper"
}
```

---

### 2. Temporal Citation Querying

#### `POST /query`
Queries indexed document and video knowledge base.
- **Body**:
```json
{
  "session_id": "session_123",
  "question": "When did the lecturer explain database indexing?"
}
```
- **Response**:
```json
{
  "answer": "At [04:15 - 04:45], the lecturer explains that database indexing uses B-Trees to minimize disk block reads...",
  "sources": [
    "[04:15 - 04:45] In this section, database indexing is introduced using B-Trees..."
  ]
}
```

---

## 🚀 Quickstart (Single Command)

### Prerequisites
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed & running.
- A [Google AI Studio Gemini API Key](https://aistudio.google.com/).

### 1. Clone & Configure
```bash
git clone https://github.com/YOUR_USERNAME/distributed-video-rag-engine.git
cd distributed-video-rag-engine

# Create .env file
echo "GEMINI_API_KEY=your_gemini_api_key_here" > .env
```

### 2. Boot the Cluster
```bash
docker compose up --build
```

Access the interactive API documentation at: **`http://localhost:8000/docs`**

---

## ⚖️ Free-Tier Limits — What Video Lengths Actually Work

Video ingestion is bounded by RAM, not by code. `start.sh` runs the FastAPI gateway and the Celery worker as **two Python processes inside one container**, so they share Render Free's single **512 MB** budget, and its **0.1 vCPU** sets the transcription speed.

Measured on Render Free with `tiny.en`, INT8, one thread:

| Process | Resident memory |
| --- | --- |
| FastAPI gateway (idle) | 142 MB |
| Celery worker (before any audio) | 103 MB |
| **Baseline the model must fit under** | **~245 MB of 512 MB** |

Whisper's weights and decode buffers must fit in the remainder. When they don't, Render SIGKILLs the container, and the task freezes at its last progress step — which looks like a hang in the UI rather than a crash. `GET /` reports the gateway's live figure under `api_memory`, and the worker logs `[MEM] <stage>: rss=..MB` per stage.

| Upload length | Status on Render Free |
| --- | --- |
| Up to 1:49 | verified end-to-end |
| Up to 3 min | the current ceiling (`MAX_VIDEO_SECONDS=180`); untested beyond what is verified above |
| Over the ceiling | refused before the upload finishes, and refused again by the worker after audio extraction |

PDF and DOCX ingestion is unaffected — no FFmpeg, no Whisper, parsed in the request path.

The ceiling is a single deployment variable. `GET /` reports `worker.max_video_seconds`, and the frontend reads it on load, so raising `MAX_VIDEO_SECONDS` in the Render dashboard takes effect without touching frontend code — set it back to `600` for a 10-minute video on a bigger instance. Transcription speed is the other bound: `CELERY_TASK_SOFT_TIME_LIMIT` (default 1200s) fails a task cleanly long before it can spin forever, so raise both together. Longer videos are better handled by running this same image on a machine with a real CPU and 2 GB+ RAM (`docker compose up --build`); no pipeline code changes.

---

## 📄 License
Distributed under the MIT License.
