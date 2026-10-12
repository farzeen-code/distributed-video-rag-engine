import os
import gc
from celery import Celery
from video_processing import transcribe_video_audio, extract_audio, unload_whisper_model
from vector_store import add_chunk

import ssl

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
if REDIS_URL.startswith("https://") or REDIS_URL.startswith("http://"):
    raise ValueError(
        "Invalid REDIS_URL: Celery requires a TCP Redis URL starting with 'rediss://' (e.g. rediss://default:...@...upstash.io:6379), NOT the REST API 'https://' URL from Upstash."
    )
if REDIS_URL.startswith("rediss://") and "ssl_cert_reqs" not in REDIS_URL:
    separator = "&" if "?" in REDIS_URL else "?"
    REDIS_URL = f"{REDIS_URL}{separator}ssl_cert_reqs=CERT_NONE"

RESULT_BACKEND = os.environ.get("RESULT_BACKEND", REDIS_URL)
if RESULT_BACKEND.startswith("rediss://") and "ssl_cert_reqs" not in RESULT_BACKEND:
    separator = "&" if "?" in RESULT_BACKEND else "?"
    RESULT_BACKEND = f"{RESULT_BACKEND}{separator}ssl_cert_reqs=CERT_NONE"

celery_app = Celery(
    "video_tasks",
    broker=REDIS_URL,
    backend=RESULT_BACKEND
)

celery_app.conf.update(
    task_track_started=True,
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
    broker_connection_retry_on_startup=True,
)

if REDIS_URL.startswith("rediss://"):
    celery_app.conf.update(
        broker_use_ssl={"ssl_cert_reqs": ssl.CERT_NONE},
        redis_backend_use_ssl={"ssl_cert_reqs": ssl.CERT_NONE},
    )

@celery_app.task(bind=True)
def process_video_task(self, video_path: str, original_filename: str):   #self: each instance of a task
    base_name, _ = os.path.splitext(video_path)
    audio_path = f"{base_name}_temp.wav"
    
    try:
        self.update_state(state="PROCESSING", meta={"step": "Extracting audio with FFmpeg", "progress": 15})
        print(f"[{self.request.id}] Extracting audio from {video_path}")
        extract_audio(video_path, audio_path)

        # Free disk and RAM pagecache immediately: raw MP4 is no longer needed
        if os.path.exists(video_path):
            try:
                os.remove(video_path)
            except Exception:
                pass
        
        self.update_state(state="PROCESSING", meta={"step": "Transcribing audio with Whisper", "progress": 40})
        print(f"[{self.request.id}] Transcribing audio..........")

        def update_whisper_progress(pct: int, msg: str):
            self.update_state(state="PROCESSING", meta={"step": msg, "progress": pct})

        segments = transcribe_video_audio(audio_path, progress_callback=update_whisper_progress)
        
        # Free Whisper RAM completely before starting ChromaDB embeddings
        unload_whisper_model()
        gc.collect()

        if not segments:
            raise ValueError("No speech was detected in the audio file")
        
        self.update_state(state="PROCESSING", meta={"step": "Indexing into vector store", "progress": 80})
        formatted_chunks = []
        for seg in segments:
            chunk_content = f"{seg['timestamp_label']} {seg['text']}"
            formatted_chunks.append(chunk_content)    
            
        print(f"[{self.request.id}] Ingesting {len(formatted_chunks)} timestamped chunks into the ChromaDB...")
        add_chunk(formatted_chunks, original_filename.lower())
        
        return{
            "status": "COMPLETED",
            "filename": original_filename,
            "total_segments": len(formatted_chunks),
            "message": f"Successfully indexed {len(formatted_chunks)} video segments withtimestamps", 
        }
        
    except Exception as e:
        print(f"[{self.request.id}] failed with error: {e}")
        raise e

    finally:
        if os.path.exists(audio_path):
            try:
                os.remove(audio_path)
            except Exception:
                pass
        if os.path.exists(video_path):
            try:
                os.remove(video_path)
            except Exception:
                pass
        gc.collect()
        
        