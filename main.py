import os
import json
import asyncio
import base64

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from dotenv import load_dotenv
from sarvamai import AsyncSarvamAI

load_dotenv()

app = FastAPI()
API_KEY = os.getenv("SARVAM_API_KEY")

# Languages supported by TTS (bulbul model)
TTS_LANGUAGES = {
    "bn-IN", "en-IN", "gu-IN", "hi-IN", "kn-IN",
    "ml-IN", "mr-IN", "od-IN", "pa-IN", "ta-IN", "te-IN",
}

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
