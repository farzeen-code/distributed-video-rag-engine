import os
import subprocess
from typing import Any, Callable, Optional
from faster_whisper import WhisperModel

WHISPER_SIZE = os.environ.get("WHISPER_MODEL_SIZE", "tiny.en")
FFMPEG_TIMEOUT_SECONDS = int(os.environ.get("FFMPEG_TIMEOUT_SECONDS", "900"))
# CTranslate2 is sized by its own cpu_threads argument; the OMP_NUM_THREADS family does not reach it.
# More than one thread multiplies Whisper's decode buffers, and the API process shares this container's 512MB.
CPU_THREADS = int(os.environ.get("WHISPER_CPU_THREADS", "1"))
WHISPER_LANGUAGE = os.environ.get("WHISPER_LANGUAGE") or None

model_instance = None

def get_whisper_model() -> WhisperModel:
    global model_instance
    if model_instance is None:
        model_instance = WhisperModel(WHISPER_SIZE, device="cpu", compute_type="int8", cpu_threads=CPU_THREADS)
    
    return model_instance

def unload_whisper_model():
    global model_instance
    if model_instance is not None:
        del model_instance
        model_instance = None
        import gc
        gc.collect()
        try:
            import ctypes
            ctypes.CDLL("libc.so.6").malloc_trim(0)
        except Exception:
            pass

def extract_audio(video_path: str, output_audio_path: str) -> None:
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Input video file does not exist: {video_path}")

    command = [
        "ffmpeg",
        "-y", # overqrite output file if exists
        "-i", video_path, 
        "-vn",   # only audio
        "-acodec", "pcm_s16le", # 16-bit uncompressed WAV 
        "-ar", "16000", # smaple rate
        "-ac", "1",     # mono
        output_audio_path
    ]
    
    try:
        results = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,  # human readable python strings
            timeout=FFMPEG_TIMEOUT_SECONDS
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(
            f"FFmpeg could not finish extracting audio within {FFMPEG_TIMEOUT_SECONDS} seconds. "
            "This video is too long or too heavily compressed for the free worker."
        )
    
    if results.returncode != 0:
        if "Output file does not contain any stream" in results.stderr:
            raise ValueError("The uploaded video file has no audio track (silent video).")
        raise RuntimeError(f"FFMPEG failed with error\n: {results.stderr}")

def get_audio_duration(audio_path: str) -> float:
    try:
        results = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=nw=1:nk=1",
                audio_path,
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=60,
        )
        return float(results.stdout.strip())
    except Exception:
        return 0.0

def format_timestamp(seconds: float) -> str:
    mins = int(seconds // 60)
    secs = int(seconds % 60)
    return f"{mins:02d}:{secs:02d}"
    
def transcribe_video_audio(
    audio_path: str,
    progress_callback: Optional[Callable[[int, str], None]] = None,
    progress_start: int = 45,
    progress_end: int = 75,
) -> list[dict[str, Any]]:
    model = get_whisper_model()

    if progress_callback:
        progress_callback(progress_start, "Decoding audio and warming up Whisper")

    segments, info = model.transcribe(
        audio_path, 
        beam_size=1,
        vad_filter=False,           # VAD disabled — saves ~80MB Silero ONNX runtime RAM
        condition_on_previous_text=False,
        temperature=0,
        language=WHISPER_LANGUAGE,   # None keeps auto-detect; set WHISPER_LANGUAGE=en to skip the detection pass
        suppress_validation=True    # keep decoding after segments fail the compression/log-prob checks
    )
        
    print(f"Detected Language '{info.language}' with probability '{info.language_probability:.2f}'")
    total_duration = max(getattr(info, "duration", 0.0) or 0.0, get_audio_duration(audio_path), 1.0)
    print(f"Transcribing {format_timestamp(total_duration)} of audio using '{WHISPER_SIZE}' on {CPU_THREADS} thread(s)")
        
    results = []
    last_percent = progress_start
    for segment in segments:
        text = segment.text.strip()
        if not text:
            continue
            
        start_fmt = format_timestamp(segment.start) 
        end_fmt = format_timestamp(segment.end)
            
        results.append({
            "start": start_fmt,
            "end": end_fmt,
            "end_seconds": round(float(segment.end), 2),
            "timestamp_label": f"[{start_fmt} - {end_fmt}]",
            "text": text
        })

        if progress_callback:
            percent = min(int(progress_start + (segment.end / total_duration) * (progress_end - progress_start)), progress_end)
            if percent != last_percent:
                last_percent = percent
                progress_callback(percent, f"Transcribing audio with Whisper ({end_fmt} / {format_timestamp(total_duration)})")
            
    if results:
        coverage = results[-1]["end_seconds"] / total_duration
        if coverage < 0.8:
            print(
                f"WARNING: transcription stopped at {format_timestamp(results[-1]['end_seconds'])} "
                f"of {format_timestamp(total_duration)} ({coverage * 100:.0f}% of audio covered). "
                "Everything after that point is NOT indexed.",
                flush=True,
            )
    return results
