import os
import subprocess
from typing import List, Dict, Any
from faster_whisper import WhisperModel

model_instance = None

def get_whisper_model() -> WhisperModel:
    global model_instance
    if model_instance is None:  #if the AI model is already loaded
        model_instance = WhisperModel("base", device="cpu", compute_type="int8")
    
    return model_instance

def extract_audio(video_path: str, output_audio_path: str) -> None:
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
    
    results = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True  # human readable python strings
    )
    
    if results.returncode != 0:
        if "Output file does not contain any stream" in results.stderr:
            raise ValueError("The uploaded video file has no audio track (silent video).")
        raise RuntimeError(f"FFMPEG failed with error\n: {results.stderr}")

def format_timestamp(seconds: float) -> str:
    mins = int(seconds // 60)
    secs = int(seconds % 60)
    return f"{mins:02d}:{secs:02d}"
    
def transcribe_video_audio(audio_path: str) -> list[dict[str, Any]]:
    model = get_whisper_model()
    segments, info = model.transcribe(audio_path, beam_size=5)
        
    print(f"Detected Language '{info.language}' with probability '{info.language_probability:.2f}'")
        
    results = []
    for segment in segments:
        text = segment.text.strip()
        if not text:
            continue
            
        start_fmt = format_timestamp(segment.start) 
        end_fmt = format_timestamp(segment.end)
            
        results.append({
            "start": start_fmt,
            "end": end_fmt,
            "timestamp_label": f"{start_fmt} - {end_fmt}",
            "text": text
        })
            
    return results