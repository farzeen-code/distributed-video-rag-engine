import os
from celery import Celery
from video_processing import transcribe_video_audio, extract_audio
from vector_store import add_chunk

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
if REDIS_URL.startswith("rediss://") and "ssl_cert_reqs" not in REDIS_URL:
    separator = "&" if "?" in REDIS_URL else "?"
    REDIS_URL = f"{REDIS_URL}{separator}ssl_cert_reqs=required"

RESULT_BACKEND = os.environ.get("RESULT_BACKEND", REDIS_URL)
if RESULT_BACKEND.startswith("rediss://") and "ssl_cert_reqs" not in RESULT_BACKEND:
    separator = "&" if "?" in RESULT_BACKEND else "?"
    RESULT_BACKEND = f"{RESULT_BACKEND}{separator}ssl_cert_reqs=required"

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
    enable_utc=True
    
)

@celery_app.task(bind=True)
def process_video_task(self, video_path: str, original_filename: str):   #self: each instance of a task
    base_name, _ = os.path.splitext(video_path)
    audio_path = f"{base_name}_temp.wav"
    
    try:
        self.update_state(state="PROCESSING", meta={"step": "Extracting audio with FFmpeg", "progress": 15})
        print(f"[{self.request.id}] Extracting audio from {video_path}")
        extract_audio(video_path, audio_path)
        
        self.update_state(state="PROCESSING", meta={"step": "Transcribing audio with Whisper", "progress": 40})
        print(f"[{self.request.id}] Transcribing audio..........")
        segments = transcribe_video_audio(audio_path)
        
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
            os.remove(audio_path)
        
        