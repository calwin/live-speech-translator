import os
import json
import asyncio
import base64
import subprocess
import uuid
import shutil
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, Form, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from dotenv import load_dotenv
from sarvamai import AsyncSarvamAI
import httpx
import static_ffmpeg

load_dotenv()

# Ensure ffmpeg binary is available (downloads static build if needed)
static_ffmpeg.add_paths()

app = FastAPI()
API_KEY = os.getenv("SARVAM_API_KEY")

# Languages supported by TTS (bulbul model)
TTS_LANGUAGES = {
    "bn-IN", "en-IN", "gu-IN", "hi-IN", "kn-IN",
    "ml-IN", "mr-IN", "od-IN", "pa-IN", "ta-IN", "te-IN",
}

# In-memory store for subtitle jobs
active_jobs: dict = {}
TEMP_DIR = Path("/tmp/subtitle_jobs")

app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def root():
    return FileResponse("static/index.html")


@app.websocket("/ws/translate")
async def websocket_translate(ws: WebSocket):
    await ws.accept()

    try:
        # Step 1: Receive config from browser
        config_raw = await ws.receive_text()
        config = json.loads(config_raw)
        source_lang = config["source_language"]
        target_lang = config["target_language"]
        tts_enabled = config.get("tts_enabled", True)
        speaker = config.get("speaker", "shubh")

        ws_lock = asyncio.Lock()

        async def safe_send(data):
            async with ws_lock:
                await ws.send_json(data)

        await safe_send({"type": "status", "message": "listening"})

        # Step 2: Create async Sarvam client
        client = AsyncSarvamAI(api_subscription_key=API_KEY)

        # Step 3: Open STT streaming connection
        async with client.speech_to_text_streaming.connect(
            model="saaras:v3",
            mode="transcribe",
            language_code=source_lang,
            high_vad_sensitivity="true",
            vad_signals="true",
            flush_signal="true",
            sample_rate="16000",
            input_audio_codec="pcm_s16le",
        ) as stt_ws:

            stop_event = asyncio.Event()

            async def forward_audio():
                """Receive audio from browser, forward to Sarvam STT."""
                try:
                    while not stop_event.is_set():
                        message = await ws.receive()
                        if "bytes" in message and message["bytes"]:
                            audio_b64 = base64.b64encode(message["bytes"]).decode("utf-8")
                            await stt_ws.transcribe(
                                audio=audio_b64,
                                encoding="audio/wav",
                                sample_rate=16000,
                            )
                        elif "text" in message and message["text"]:
                            data = json.loads(message["text"])
                            if data.get("type") == "stop":
                                await stt_ws.flush()
                                stop_event.set()
                                return
                except WebSocketDisconnect:
                    stop_event.set()

            async def translate_and_speak(text):
                """Translate text, send to browser, then generate TTS audio."""
                try:
                    if source_lang != target_lang:
                        result = await client.text.translate(
                            input=text,
                            source_language_code=source_lang,
                            target_language_code=target_lang,
                            model="sarvam-translate:v1",
                        )
                        translated = result.translated_text
                    else:
                        translated = text

                    await safe_send({
                        "type": "translation",
                        "text": translated,
                        "language": target_lang,
                    })

                    # Generate TTS if enabled and target language is supported
                    if tts_enabled and target_lang in TTS_LANGUAGES and translated:
                        try:
                            tts_result = await client.text_to_speech.convert(
                                text=translated,
                                target_language_code=target_lang,
                                model="bulbul:v3",
                                speaker=speaker,
                                output_audio_codec="mp3",
                            )
                            if tts_result.audios and tts_result.audios[0]:
                                await safe_send({
                                    "type": "audio",
                                    "data": tts_result.audios[0],
                                })
                        except Exception:
                            pass

                except Exception:
                    await safe_send({
                        "type": "translation",
                        "text": "[Translation unavailable]",
                        "language": target_lang,
                    })

            async def process_transcripts():
                """Receive transcripts from Sarvam, translate+speak, send to browser."""
                tasks = []
                try:
                    async for message in stt_ws:
                        if message.type == "events":
                            signal = getattr(message.data, "signal_type", None)
                            if signal == "START_SPEECH":
                                await safe_send({"type": "vad", "event": "start"})
                            elif signal == "END_SPEECH":
                                await safe_send({"type": "vad", "event": "end"})
                            continue
                        if message.type == "error":
                            await safe_send({
                                "type": "error",
                                "message": "Speech recognition error",
                            })
                            continue
                        if message.type != "data":
                            continue

                        text = message.data.transcript
                        if not text or not text.strip():
                            continue

                        text = text.strip()

                        # Send transcript immediately
                        await safe_send({
                            "type": "transcript",
                            "text": text,
                            "language": source_lang,
                        })

                        # Fire off translation + TTS without waiting
                        task = asyncio.create_task(translate_and_speak(text))
                        tasks.append(task)

                        if stop_event.is_set():
                            break

                    # Wait for any pending translations to finish
                    if tasks:
                        await asyncio.gather(*tasks, return_exceptions=True)
                except Exception:
                    await safe_send({"type": "error", "message": "Processing error"})

            # Run both tasks concurrently
            await asyncio.gather(forward_audio(), process_transcripts())

        await safe_send({"type": "status", "message": "done"})

    except WebSocketDisconnect:
        pass
    except Exception:
        try:
            await ws.send_json({"type": "error", "message": "Connection error"})
        except Exception:
            pass
    finally:
        try:
            await ws.close()
        except Exception:
            pass


# ─── Video Subtitle Translator ──────────────────────────────────────────────


def extract_audio(video_path: str, audio_path: str):
    """Extract audio from video as 16kHz mono WAV using ffmpeg."""
    result = subprocess.run(
        [
            "ffmpeg", "-i", video_path,
            "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
            "-y", audio_path,
        ],
        capture_output=True, text=True, timeout=300,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {result.stderr[:500]}")


def build_subtitle_cues(result_data: dict) -> list:
    """Parse STT result JSON into subtitle cues [{start, end, text}]."""
    # Prefer diarized entries (segment-level with natural phrase boundaries)
    diarized = result_data.get("diarized_transcript", {})
    entries = diarized.get("entries", [])
    if entries:
        return [
            {
                "start": e["start_time_seconds"],
                "end": e["end_time_seconds"],
                "text": e["transcript"].strip(),
            }
            for e in entries
            if e.get("transcript", "").strip()
        ]

    # Fall back to word-level timestamps, group into cues
    ts = result_data.get("timestamps", {})
    words = ts.get("words", [])
    starts = ts.get("start_time_seconds", [])
    ends = ts.get("end_time_seconds", [])

    if not words or len(words) != len(starts) or len(words) != len(ends):
        # Last resort: return full transcript as single cue
        transcript = result_data.get("transcript", "")
        if transcript.strip():
            return [{"start": 0.0, "end": 10.0, "text": transcript.strip()}]
        return []

    cues = []
    current_words = []
    current_start = starts[0]

    for i, word in enumerate(words):
        current_words.append(word)
        is_last = i == len(words) - 1
        has_pause = not is_last and starts[i + 1] - ends[i] > 0.5
        enough_words = len(current_words) >= 8

        if is_last or has_pause or enough_words:
            cues.append({
                "start": current_start,
                "end": ends[i],
                "text": " ".join(current_words),
            })
            current_words = []
            if not is_last:
                current_start = starts[i + 1]

    return cues


async def translate_cues(client, cues: list, source_lang: str, target_lang: str):
    """Translate all cue texts in parallel with rate limiting."""
    if source_lang == target_lang:
        for cue in cues:
            cue["translated_text"] = cue["text"]
        return

    sem = asyncio.Semaphore(5)

    async def translate_one(cue):
        async with sem:
            try:
                result = await client.text.translate(
                    input=cue["text"],
                    source_language_code=source_lang,
                    target_language_code=target_lang,
                    model="sarvam-translate:v1",
                )
                cue["translated_text"] = result.translated_text
            except Exception:
                cue["translated_text"] = cue["text"]

    await asyncio.gather(*[translate_one(c) for c in cues])


def format_vtt_time(seconds: float) -> str:
    """Convert seconds to WebVTT timestamp HH:MM:SS.mmm."""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def generate_vtt(cues: list) -> str:
    """Generate WebVTT subtitle string from translated cues."""
    lines = ["WEBVTT", ""]
    for i, cue in enumerate(cues, 1):
        start = format_vtt_time(cue["start"])
        end = format_vtt_time(cue["end"])
        text = cue.get("translated_text", cue["text"])
        lines.extend([str(i), f"{start} --> {end}", text, ""])
    return "\n".join(lines)


def cleanup_job(job_id: str):
    """Remove temp files for a completed job."""
    job_dir = TEMP_DIR / job_id
    if job_dir.exists():
        shutil.rmtree(job_dir, ignore_errors=True)
    active_jobs.pop(job_id, None)


@app.get("/subtitles")
async def subtitles_page():
    return FileResponse("static/subtitles.html")


@app.post("/api/subtitles/upload")
async def upload_video(
    file: UploadFile,
    source_lang: str = Form(...),
    target_lang: str = Form(...),
):
    # Validate content type
    if not file.content_type or not file.content_type.startswith("video/"):
        raise HTTPException(400, "Please upload a video file")

    # Create temp directory for this job
    job_id = str(uuid.uuid4())[:8]
    job_dir = TEMP_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    try:
        # Save uploaded video
        video_path = str(job_dir / "input_video")
        with open(video_path, "wb") as f:
            content = await file.read()
            if len(content) > 200 * 1024 * 1024:  # 200MB
                shutil.rmtree(job_dir, ignore_errors=True)
                raise HTTPException(400, "File too large (max 200MB)")
            f.write(content)

        # Extract audio
        audio_path = str(job_dir / "audio.wav")
        extract_audio(video_path, audio_path)

        # Create Sarvam batch STT job
        client = AsyncSarvamAI(api_subscription_key=API_KEY)
        job = await client.speech_to_text_job.create_job(
            with_timestamps=True,
            with_diarization=True,
            language_code=source_lang,
        )
        await job.upload_files([audio_path])
        await job.start()

        # Store job info
        active_jobs[job_id] = {
            "sarvam_job": job,
            "source_lang": source_lang,
            "target_lang": target_lang,
            "job_dir": str(job_dir),
        }

        return JSONResponse({"job_id": job_id})

    except HTTPException:
        raise
    except Exception as e:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(500, f"Failed to process video: {str(e)[:200]}")


@app.websocket("/ws/subtitles/{job_id}")
async def websocket_subtitles(ws: WebSocket, job_id: str):
    await ws.accept()

    job_info = active_jobs.get(job_id)
    if not job_info:
        await ws.send_json({"type": "error", "message": "Job not found"})
        await ws.close()
        return

    try:
        job = job_info["sarvam_job"]
        source_lang = job_info["source_lang"]
        target_lang = job_info["target_lang"]
        job_dir = job_info["job_dir"]

        # Phase 1: Poll STT job status
        await ws.send_json({"type": "progress", "percent": 30, "message": "Transcribing audio..."})

        poll_count = 0
        while True:
            status = await job.get_status()
            state = status.job_state.lower()
            if state == "completed":
                break
            elif state == "failed":
                await ws.send_json({"type": "error", "message": "Transcription failed"})
                return
            poll_count += 1
            progress = min(30 + poll_count * 3, 55)
            await ws.send_json({"type": "progress", "percent": progress, "message": "Transcribing audio..."})
            await asyncio.sleep(3)

        # Phase 2: Download results
        await ws.send_json({"type": "progress", "percent": 60, "message": "Processing transcript..."})

        output_dir = str(Path(job_dir) / "output")
        await job.download_outputs(output_dir)

        # Read the result JSON
        result_data = None
        for f in Path(output_dir).glob("*.json"):
            with open(f) as fp:
                result_data = json.load(fp)
            break

        if not result_data:
            await ws.send_json({"type": "error", "message": "No transcription results found"})
            return

        # Phase 3: Build subtitle cues
        cues = build_subtitle_cues(result_data)
        if not cues:
            await ws.send_json({"type": "error", "message": "No speech detected in the video"})
            return

        # If auto-detect was used, get the detected language from STT result
        if source_lang == "unknown":
            detected = result_data.get("language_code")
            if detected:
                source_lang = detected

        # Phase 4: Translate
        await ws.send_json({
            "type": "progress", "percent": 75,
            "message": f"Translating {len(cues)} subtitle segments...",
        })

        client = AsyncSarvamAI(api_subscription_key=API_KEY)
        await translate_cues(client, cues, source_lang, target_lang)

        # Phase 5: Generate VTT
        await ws.send_json({"type": "progress", "percent": 90, "message": "Generating subtitles..."})
        vtt_content = generate_vtt(cues)

        await ws.send_json({"type": "complete", "vtt": vtt_content})

    except Exception:
        try:
            await ws.send_json({"type": "error", "message": "Processing error"})
        except Exception:
            pass
    finally:
        cleanup_job(job_id)
        try:
            await ws.close()
        except Exception:
            pass
