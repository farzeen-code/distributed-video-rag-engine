import os
import gc
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

def _read_cgroup_usage_and_stat() -> tuple[int, dict[str, int]]:
    """Return (memory.current in MB, memory.stat counters in MB)."""
    pairs = (
        ("/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory.stat"),
        ("/sys/fs/cgroup/memory/memory.usage_in_bytes", "/sys/fs/cgroup/memory/memory.stat"),
    )
    for usage_path, stat_path in pairs:
        try:
            with open(usage_path) as handle:
                container_mb = int(handle.read().strip()) // (1024 * 1024)
            stat_mb: dict[str, int] = {}
            with open(stat_path) as handle:
                for line in handle:
                    parts = line.split()
                    if len(parts) >= 2 and parts[0].isidentifier():
                        stat_mb[parts[0]] = int(parts[1]) // (1024 * 1024)
            return container_mb, stat_mb
        except Exception:
            continue
    return 0, {}


def read_memory() -> dict:
    # Render OOM compares memory.current to memory.max for the whole container (gateway + worker + FFmpeg).
    try:
        with open("/proc/self/status") as handle:
            values = {}
            for line in handle:
                if line.startswith(("VmRSS:", "VmHWM:")):
                    values[line.split()[0]] = int(line.split()[1]) // 1024
    except Exception:
        values = {}

    container_mb, stat_mb = _read_cgroup_usage_and_stat()
    anon_mb = stat_mb.get("anon", stat_mb.get("total_rss", 0))
    file_mb = stat_mb.get("file", stat_mb.get("cache", 0))
    shmem_mb = stat_mb.get("shmem", 0)
    slab_mb = stat_mb.get("slab", stat_mb.get("total_slab", 0))

    limit_mb = 0
    for limit_path in ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
        try:
            with open(limit_path) as handle:
                raw = handle.read().strip()
            if raw != "max":
                bytes_limit = int(raw)
                if 0 < bytes_limit < 64 * 1024 * 1024 * 1024:
                    limit_mb = bytes_limit // (1024 * 1024)
            break
        except Exception:
            continue

    # memory.current is what the kernel enforces; anon alone misses tmpfs/shmem (e.g. WAV on a shmem-backed disk).
    cgroup_gap_mb = max(0, container_mb - anon_mb)
    # shmem is tmpfs: the uploaded clip and the extracted WAV if Render mounts the storage dir that way. The
    # kernel reclaims page cache before it kills, but it cannot reclaim shmem, so anon+shmem is the honest
    # budget. cgroup_gap_mb says how much of the total is the reclaimable part, which is what the next test
    # round needs to show before this guard can be trusted over raw container_mb.
    hard_mb = anon_mb + shmem_mb

    return {
        "rss_mb": values.get("VmRSS:", 0),
        "peak_mb": values.get("VmHWM:", 0),
        "container_mb": container_mb,
        "container_anon_mb": anon_mb,
        "container_file_mb": file_mb,
        "container_shmem_mb": shmem_mb,
        "container_slab_mb": slab_mb,
        "container_hard_mb": hard_mb,
        "cgroup_gap_mb": cgroup_gap_mb,
        "kill_metric_mb": container_mb,
        "limit_mb": limit_mb,
    }

def used_memory_mb(mem: dict) -> int:
    # Falls back to anon on a cgroup v1 host, where the split is not reported.
    return mem.get("container_hard_mb") or mem["container_anon_mb"]

def log_memory(stage: str):
    mem = read_memory()
    print(
        f"[MEM] {stage}: rss={mem['rss_mb']}MB peak={mem['peak_mb']}MB "
        f"container={mem['container_mb']}MB anon={mem['container_anon_mb']}MB "
        f"shmem={mem['container_shmem_mb']}MB hard={used_memory_mb(mem)}MB limit={mem['limit_mb']}MB",
        flush=True,
    )
    return mem

# Two formulas have now been fitted to three noisy peaks and falsified by a Render OOM email, so nothing
# here extrapolates. These are the observed endpoints: a 3:47 clip finished at 304MB of anon, a 5:40 clip
# was read at 463MB twenty-one seconds into decoding and then the container restarted (159MB is the fresh
# boot baseline). Cost is flat-ish up to ~4 minutes and climbs steeply after it, which is a shape this
# linear model cannot represent - so the verified ceiling below is what refuses uploads, not the fit.
WHISPER_LOAD_COST_MB = int(os.environ.get("WHISPER_LOAD_COST_MB", "150"))
WHISPER_DECODE_MB_PER_MINUTE = int(os.environ.get("WHISPER_DECODE_MB_PER_MINUTE", "5"))

# The longest length this deployment has actually been observed to complete. Acts as a hard clamp on both
# what GET / advertises and what the worker's guard allows, so raising MAX_VIDEO_SECONDS in the dashboard
# cannot route an upload into a container kill.
MAX_VERIFIED_VIDEO_SECONDS = int(os.environ.get("MAX_VERIFIED_VIDEO_SECONDS", "240"))

# Self-imposed tripwire. Render's SIGKILL takes the worker, the queued task and the API with it, and leaves
# a ghost frozen at the last heartbeat plus an email. Aborting one notch below the limit turns the same
# event into a readable FAILURE that also reports where the curve actually broke.
WHISPER_ABORT_ANON_MB = int(os.environ.get("WHISPER_ABORT_ANON_MB", "440"))

# GET / measures anon in the gateway while the worker is still idle; by the time the task guards, it has
# imported faster_whisper/numpy and run FFmpeg, so it sees strictly more. Advertising without this margin
# over-promises, which is why a 3:54 clip passed the cap check on the page and was refused by the worker.
# Advertising now subtracts only what the worker actually spends before the guard samples: a 2:20 clip
# measured 13MB of import cost. Kept as a variable because it is the one term GET / cannot observe.
WHISPER_ADVERTISE_MARGIN_MB = int(os.environ.get("WHISPER_ADVERTISE_MARGIN_MB", "13"))

def affordable_video_seconds(mem: dict = None, margin_mb: int = 0) -> int:
    """
    Length of audio that fits alongside whatever this container is already holding, clamped to the longest
    run ever completed here. The headroom term may lower it on a warm gateway; it can never raise the
    ceiling above MAX_VERIFIED_VIDEO_SECONDS. Returns 0 when there is no cgroup data to reason about.
    """
    mem = mem or read_memory()
    limit = mem["limit_mb"]
    if not limit:
        return 0
    free_mb = limit - used_memory_mb(mem) - margin_mb
    minutes = (free_mb - WHISPER_LOAD_COST_MB) // WHISPER_DECODE_MB_PER_MINUTE
    return max(0, min(int(minutes) * 60, MAX_VERIFIED_VIDEO_SECONDS))

def start_memory_watcher(interval: int = 15, peak: dict = None, abort: dict = None) -> "threading.Event":
    # Segment-based samples go silent while Whisper is busy, which is exactly when a kill happens.
    stop = threading.Event()
    def watch():
        while not stop.wait(interval):
            mem = log_memory("watcher")
            record_peak(peak, mem)
            tripwire(mem, abort)
    threading.Thread(target=watch, daemon=True).start()
    return stop

def abort_threshold_mb(limit_mb: int) -> int:
    # Leave a few dozen MB so the abort lands while the worker can still clean up and report, rather than
    # after the kernel has already picked a victim. On the 512MB free container this is WHISPER_ABORT_ANON_MB.
    # Measured against anon+shmem, not raw anon.
    if not limit_mb:
        return WHISPER_ABORT_ANON_MB
    return min(WHISPER_ABORT_ANON_MB, limit_mb - 72)

def tripwire(mem: dict, abort: dict):
    # A background thread cannot raise into the task, so it only flips the flag; every heartbeat re-reads it.
    if abort is None or abort.get("used_mb"):
        return
    used = used_memory_mb(mem)
    threshold = abort_threshold_mb(mem["limit_mb"])
    if used and used >= threshold:
        abort["used_mb"] = used
        abort["anon_mb"] = mem["container_anon_mb"]
        abort["shmem_mb"] = mem["container_shmem_mb"]
        abort["limit_mb"] = mem["limit_mb"]
        abort["threshold_mb"] = threshold
        print(f"[MEM] tripwire fired at {used}MB of {mem['limit_mb']}MB", flush=True)

def record_peak(peak: dict, mem: dict):
    if peak is None:
        return
    peak["container_anon_mb"] = max(peak.get("container_anon_mb", 0), mem["container_anon_mb"])
    peak["container_hard_mb"] = max(peak.get("container_hard_mb", 0), used_memory_mb(mem))
    peak["rss_mb"] = max(peak.get("rss_mb", 0), mem["peak_mb"])
    peak["limit_mb"] = mem["limit_mb"]

@celery_app.task(bind=True)
def process_video_task(self, video_path: str, original_filename: str):   #self: each instance of a task
    video_path = os.path.abspath(video_path)
    base_name, _ = os.path.splitext(video_path)
    audio_path = f"{base_name}_temp.wav"
    
    try:
        # Sampled before the heavy import so the cost of importing faster_whisper/numpy is measurable:
        # this is roughly what GET / saw when it advertised the cap.
        idle_mem = log_memory("worker idle")
        from video_processing import transcribe_video_audio, extract_audio, unload_whisper_model, get_audio_duration, get_whisper_model

        log_memory("after imports")

        if not os.path.exists(video_path):
            raise FileNotFoundError(
                f"Video file '{original_filename}' was not found on worker storage. "
                "This typically occurs if the server redeployed while the task was in queue. "
                "Please re-upload the video."
            )

        # Flipped by the watcher thread when the container nears the kill point; a thread cannot raise into
        # the task, so every heartbeat re-reads it and unwinds from here instead.
        abort = {}

        def report(progress: int, step: str):
            if abort.get("used_mb"):
                raise ValueError(
                    f"Stopped deliberately at {abort['used_mb']}MB of {abort['limit_mb']}MB "
                    f"({abort['anon_mb']}MB heap + {abort['shmem_mb']}MB tmpfs), just short of the point where "
                    "Render kills the container. This clip is longer than the free tier can transcribe "
                    f"({MAX_VERIFIED_VIDEO_SECONDS // 60} min is the longest run completed here). "
                    "Upload a shorter clip."
                )
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
        # Clamped by the verified ceiling so raising MAX_VIDEO_SECONDS in the dashboard refuses uploads in
        # the worker instead of routing them into a container kill.
        max_seconds = min(int(os.environ.get("MAX_VIDEO_SECONDS", "240")), MAX_VERIFIED_VIDEO_SECONDS)
        if audio_seconds > max_seconds:
            cap = f"{max_seconds / 60:.1f} minutes" if max_seconds >= 60 else f"{max_seconds} seconds"
            raise ValueError(
                f"This video is {audio_seconds / 60:.1f} minutes long, and the free worker caps "
                f"ingestion at {cap}. Please upload a shorter clip."
            )

        report(42, "Loading Whisper model")
        print(f"[{self.request.id}] Transcribing {audio_seconds:.0f}s of audio", flush=True)

        # The peak is what decides the real video ceiling, so it goes back with the result instead of
        # only living in log output nobody has to filter to read.
        peak_seen = {}

        def update_whisper_progress(pct: int, msg: str):
            mem = log_memory(f"transcribing {pct}%")
            record_peak(peak_seen, mem)
            tripwire(mem, abort)
            report(pct, msg)

        # Refuse before the load instead of letting Render SIGKILL the container mid-decode.
        at_guard = read_memory()
        peak_seen["preload_cost_mb"] = max(0, at_guard["container_anon_mb"] - idle_mem["container_anon_mb"])
        affordable = affordable_video_seconds(at_guard)
        if affordable and audio_seconds > affordable:
            raise ValueError(
                f"This clip is {audio_seconds / 60:.1f} min and {affordable / 60:.1f} min is the most this "
                f"{at_guard['limit_mb']}MB container can take right now. That is either the memory the gateway "
                "is still holding from recent queries, or the ceiling of the longest run completed on this "
                f"deployment ({MAX_VERIFIED_VIDEO_SECONDS / 60:.0f} min). Upload a shorter clip - the gateway "
                "gives its memory back when the service restarts, not between requests."
            )

        # Load the weights here so the sample lands after they are resident; transcribe reuses the cached instance.
        get_whisper_model()
        record_peak(peak_seen, log_memory("after model load"))

        stop_watching = start_memory_watcher(peak=peak_seen, abort=abort)
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
        if peak_seen.get("container_anon_mb") and peak_seen.get("limit_mb"):
            completion_message += (
                f" (container peaked at {peak_seen['container_anon_mb']}MB anon / "
                f"{peak_seen.get('container_hard_mb', peak_seen['container_anon_mb'])}MB incl. tmpfs "
                f"of {peak_seen['limit_mb']}MB, worker pre-load {peak_seen.get('preload_cost_mb', 0)}MB)"
            )
        if coverage_pct and coverage_pct < 80:
            completion_message += f" - warning: only {coverage_pct}% of the audio was transcribed"

        return{
            "status": "COMPLETED",
            "filename": original_filename,
            "total_segments": len(formatted_chunks),
            "transcript_coverage_percent": coverage_pct,
            "peak_memory": peak_seen,
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
