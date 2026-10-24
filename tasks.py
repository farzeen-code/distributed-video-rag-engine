import os
import gc
import math
import time
import threading
from celery import Celery
import sys
import ssl

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

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
    task_soft_time_limit=int(os.environ.get("CELERY_TASK_SOFT_TIME_LIMIT", "1800")),
    task_time_limit=int(os.environ.get("CELERY_TASK_TIME_LIMIT", "2100")),
    task_reject_on_worker_lost=True,
)

if REDIS_URL.startswith("rediss://"):
    celery_app.conf.update(
        broker_use_ssl={"ssl_cert_reqs": ssl.CERT_NONE},
        redis_backend_use_ssl={"ssl_cert_reqs": ssl.CERT_NONE},
    )

def read_memory() -> dict:
    # Render kills on the container total, not per process: the gateway, the worker and FFmpeg all draw from one 512MB.
    try:
        with open("/proc/self/status") as handle:
            values = {}
            for line in handle:
                if line.startswith(("VmRSS:", "VmHWM:")):
                    values[line.split()[0]] = int(line.split()[1]) // 1024
    except Exception:
        values = {}

    container_mb = 0
    anon_mb = 0
    # The cgroup total counts page cache, which ChromaDB's sqlite reads inflate. anon is the part
    # Render cannot reclaim, so that is the number to compare against 512MB when guessing a kill point.
    for usage_path, stat_path, key in (
        ("/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory.stat", "anon"),
        ("/sys/fs/cgroup/memory/memory.usage_in_bytes", "/sys/fs/cgroup/memory/memory.stat", "total_rss"),
    ):
        try:
            with open(usage_path) as handle:
                container_mb = int(handle.read().strip()) // (1024 * 1024)
            with open(stat_path) as handle:
                for line in handle:
                    if line.startswith(key + " "):
                        anon_mb = int(line.split()[1]) // (1024 * 1024)
                        break
        except Exception:
            continue
        break

    limit_mb = 0
    for limit_path in ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
        try:
            with open(limit_path) as handle:
                raw = handle.read().strip()
            if raw != "max":
                bytes_limit = int(raw)
                # An "unlimited" cgroup reports a huge sentinel; only a real cap is worth acting on.
                if 0 < bytes_limit < 64 * 1024 * 1024 * 1024:
                    limit_mb = bytes_limit // (1024 * 1024)
            break
        except Exception:
            continue

    return {
        "rss_mb": values.get("VmRSS:", 0),
        "peak_mb": values.get("VmHWM:", 0),
        "container_mb": container_mb,
        "container_anon_mb": anon_mb,
        "limit_mb": limit_mb,
    }

def log_memory(stage: str):
    mem = read_memory()
    print(
        f"[MEM] {stage}: rss={mem['rss_mb']}MB peak={mem['peak_mb']}MB "
        f"container={mem['container_mb']}MB anon={mem['container_anon_mb']}MB limit={mem['limit_mb']}MB",
        flush=True,
    )

def start_memory_watcher(interval: int = 15) -> "threading.Event":
    # Segment-based samples go silent while Whisper is busy, which is exactly when a kill happens.
    stop = threading.Event()
    def watch():
        while not stop.wait(interval):
            log_memory("watcher")
    threading.Thread(target=watch, daemon=True).start()
    return stop

@celery_app.task(bind=True)
def process_video_task(self, video_path: str, original_filename: str):   #self: each instance of a task
    video_path = os.path.abspath(video_path)
    base_name, _ = os.path.splitext(video_path)
    audio_path = f"{base_name}_temp.wav"
    
    try:
        from video_processing import transcribe_video_audio, extract_audio, unload_whisper_model, get_audio_duration, get_whisper_model

        log_memory("task start")

        if not os.path.exists(video_path):
            raise FileNotFoundError(
                f"Video file '{original_filename}' was not found on worker storage. "
                "This typically occurs if the server redeployed while the task was in queue. "
                "Please re-upload the video."
            )

        def report(progress: int, step: str):
            self.update_state(state="PROCESSING", meta={"step": step, "progress": progress, "updated_at": time.time()})

        report(38, "Extracting audio with FFmpeg")
        print(f"[{self.request.id}] Extracting audio from {video_path}", flush=True)
        extract_audio(video_path, audio_path)
        log_memory("after ffmpeg")

        # To ensure that render memory does not exceed limit, dump the file as soon as it is transcribed
        if os.path.exists(video_path):
            try:
                os.remove(video_path)
            except Exception:
                pass

        audio_seconds = get_audio_duration(audio_path)
        max_seconds = int(os.environ.get("MAX_VIDEO_SECONDS", "240"))
        if audio_seconds > max_seconds:
            cap = f"{max_seconds / 60:.1f} minutes" if max_seconds >= 60 else f"{max_seconds} seconds"
            raise ValueError(
                f"This video is {audio_seconds / 60:.1f} minutes long, and the free worker caps "
                f"ingestion at {cap}. Please upload a shorter clip."
            )

        report(42, "Loading Whisper model")
        print(f"[{self.request.id}] Transcribing {audio_seconds:.0f}s of audio", flush=True)

        def update_whisper_progress(pct: int, msg: str):
            log_memory(f"transcribing {pct}%")
            report(pct, msg)

        # Refuse before the load instead of letting Render SIGKILL the container mid-decode.
        # Constants are the measured cost of tiny.en int8 on this tier: loading is ~276MB regardless of
        # length, and a 4:00 clip reached ~438MB anon from a 162MB start, so decode is ~16MB/minute.
        before_load = read_memory()
        load_cost = int(os.environ.get("WHISPER_LOAD_COST_MB", "276"))
        minutes = max(1, math.ceil(audio_seconds / 60))
        decode_reserve = int(os.environ.get("WHISPER_DECODE_MB_PER_MINUTE", "16")) * minutes
        limit = before_load["limit_mb"]
        free_mb = limit - before_load["container_anon_mb"]
        if limit and load_cost + decode_reserve > free_mb:
            raise ValueError(
                f"{minutes} minute(s) of audio needs ~{load_cost + decode_reserve}MB free and only {free_mb}MB is "
                "available. Whisper costs the same to load at any length, so only a shorter clip fits right now - "
                "the gateway gives its memory back when the service restarts, not between requests."
            )

        # Load the weights here so the sample lands after they are resident; transcribe reuses the cached instance.
        get_whisper_model()
        log_memory("after model load")

        stop_watching = start_memory_watcher()
        try:
            segments = transcribe_video_audio(audio_path, progress_callback=update_whisper_progress, progress_start=45, progress_end=75)
        finally:
            stop_watching.set()
        
        # Free Whisper RAM completely before starting ChromaDB embeddings
        unload_whisper_model()
        gc.collect()
        try:
            import ctypes
            ctypes.CDLL("libc.so.6").malloc_trim(0)
        except Exception:
            pass
        log_memory("after whisper unload")

        if not segments:
            raise ValueError("No speech was detected in the audio file")
        
        report(80, "Indexing into vector store")
        formatted_chunks = []
        for seg in segments:
            chunk_content = f"{seg['timestamp_label']} {seg['text']}"
            formatted_chunks.append(chunk_content)    
            
        print(f"[{self.request.id}] Ingesting {len(formatted_chunks)} timestamped chunks into the ChromaDB...", flush=True)
        
        from vector_store import add_chunk

        # Embedding over the network is the slowest stage and previously sent no heartbeat,
        # which made the UI declare a stall on runs that had actually succeeded.
        def report_indexing(fraction: float, msg: str):
            report(80 + int(fraction * 15), msg)

        add_chunk(formatted_chunks, original_filename.lower(), progress_callback=report_indexing)
        log_memory("after chromadb index")
        
        coverage_pct = 0
        if audio_seconds > 0 and segments:
            coverage_pct = round(min(segments[-1].get("end_seconds", 0.0) / audio_seconds, 1.0) * 100)

        completion_message = f"Successfully indexed {len(formatted_chunks)} video segments with timestamps"
        if coverage_pct and coverage_pct < 80:
            completion_message += f" - warning: only {coverage_pct}% of the audio was transcribed"

        return{
            "status": "COMPLETED",
            "filename": original_filename,
            "total_segments": len(formatted_chunks),
            "transcript_coverage_percent": coverage_pct,
            "message": completion_message, 
        }
        
    except Exception as e:
        import traceback
        from celery.exceptions import SoftTimeLimitExceeded
        if isinstance(e, SoftTimeLimitExceeded):
            e = RuntimeError(
                "Transcription hit the worker time limit before finishing. "
                "This video is too long for the free tier - try a shorter clip."
            )
        print(f"[{self.request.id}] failed with error: {e}", flush=True)
        print(traceback.format_exc(), flush=True)
        raise e

    finally:
        try:
            from video_processing import unload_whisper_model
            unload_whisper_model()
        except Exception:
            pass
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
        try:
            import ctypes
            ctypes.CDLL("libc.so.6").malloc_trim(0)
        except Exception:
            pass
