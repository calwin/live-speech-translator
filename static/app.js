const SPEAKERS = [
    { id: "shubh",    label: "Male Voice 1" },
    { id: "aditya",   label: "Male Voice 2" },
    { id: "rahul",    label: "Male Voice 3" },
    { id: "rohan",    label: "Male Voice 4" },
    { id: "amit",     label: "Male Voice 5" },
    { id: "dev",      label: "Male Voice 6" },
    { id: "ratan",    label: "Male Voice 7" },
    { id: "varun",    label: "Male Voice 8" },
    { id: "manan",    label: "Male Voice 9" },
    { id: "sumit",    label: "Male Voice 10" },
    { id: "kabir",    label: "Male Voice 11" },
    { id: "aayan",    label: "Male Voice 12" },
    { id: "ashutosh", label: "Male Voice 13" },
    { id: "advait",   label: "Male Voice 14" },
    { id: "anand",    label: "Male Voice 15" },
    { id: "tarun",    label: "Male Voice 16" },
    { id: "sunny",    label: "Male Voice 17" },
    { id: "mani",     label: "Male Voice 18" },
    { id: "gokul",    label: "Male Voice 19" },
    { id: "vijay",    label: "Male Voice 20" },
    { id: "mohit",    label: "Male Voice 21" },
    { id: "rehan",    label: "Male Voice 22" },
    { id: "soham",    label: "Male Voice 23" },
    { id: "ritu",     label: "Female Voice 1" },
    { id: "priya",    label: "Female Voice 2" },
    { id: "neha",     label: "Female Voice 3" },
    { id: "pooja",    label: "Female Voice 4" },
    { id: "simran",   label: "Female Voice 5" },
    { id: "kavya",    label: "Female Voice 6" },
    { id: "ishita",   label: "Female Voice 7" },
    { id: "shreya",   label: "Female Voice 8" },
    { id: "roopa",    label: "Female Voice 9" },
    { id: "amelia",   label: "Female Voice 10" },
    { id: "sophia",   label: "Female Voice 11" },
    { id: "tanya",    label: "Female Voice 12" },
    { id: "shruti",   label: "Female Voice 13" },
    { id: "suhani",   label: "Female Voice 14" },
    { id: "kavitha",  label: "Female Voice 15" },
    { id: "rupali",   label: "Female Voice 16" },
];

// Languages that support text-to-speech (bulbul:v3)
const TTS_LANGUAGES = new Set([
    "bn-IN", "en-IN", "gu-IN", "hi-IN", "kn-IN",
    "ml-IN", "mr-IN", "od-IN", "pa-IN", "ta-IN", "te-IN",
]);

const LANGUAGES = [
    { code: "en-IN", name: "English" },
    { code: "hi-IN", name: "Hindi" },
    { code: "bn-IN", name: "Bengali" },
    { code: "ta-IN", name: "Tamil" },
    { code: "te-IN", name: "Telugu" },
    { code: "mr-IN", name: "Marathi" },
    { code: "gu-IN", name: "Gujarati" },
    { code: "kn-IN", name: "Kannada" },
    { code: "ml-IN", name: "Malayalam" },
    { code: "pa-IN", name: "Punjabi" },
    { code: "od-IN", name: "Odia" },
    { code: "as-IN", name: "Assamese" },
    { code: "ur-IN", name: "Urdu" },
    { code: "ne-IN", name: "Nepali" },
    { code: "sa-IN", name: "Sanskrit" },
    { code: "ks-IN", name: "Kashmiri" },
    { code: "sd-IN", name: "Sindhi" },
    { code: "doi-IN", name: "Dogri" },
    { code: "kok-IN", name: "Konkani" },
    { code: "mai-IN", name: "Maithili" },
    { code: "mni-IN", name: "Manipuri" },
    { code: "sat-IN", name: "Santali" },
    { code: "brx-IN", name: "Bodo" },
];

// DOM elements
const sourceSelect = document.getElementById("source-lang");
const targetSelect = document.getElementById("target-lang");
const micBtn = document.getElementById("mic-btn");
const micLabel = micBtn.querySelector(".mic-label");
const statusEl = document.getElementById("status");
const transcriptEl = document.getElementById("transcript");
const translationEl = document.getElementById("translation");
const heardLangEl = document.getElementById("heard-lang");
const translatedLangEl = document.getElementById("translated-lang");
const swapBtn = document.getElementById("swap-languages");
const ttsToggle = document.getElementById("tts-toggle");
const voiceSelect = document.getElementById("voice-select");
const voiceSelectWrap = document.getElementById("voice-select-wrap");

// Populate voice selector
SPEAKERS.forEach((s) => {
    voiceSelect.add(new Option(s.label, s.id));
});

// Toggle voice picker visibility based on TTS checkbox
function updateVoiceSelectVisibility() {
    voiceSelectWrap.classList.toggle("hidden", !ttsToggle.checked);
}
ttsToggle.addEventListener("change", updateVoiceSelectVisibility);
updateVoiceSelectVisibility();

// State
let isRecording = false;
let audioContext = null;
let workletNode = null;
let sourceNode = null;
let mediaStream = null;
let websocket = null;

// Audio playback queue
const audioQueue = [];
let isPlaying = false;

async function playNextAudio() {
    if (isPlaying || audioQueue.length === 0) return;
    isPlaying = true;

    const base64Audio = audioQueue.shift();
    try {
        const audioBytes = Uint8Array.from(atob(base64Audio), (c) => c.charCodeAt(0));
        const blob = new Blob([audioBytes], { type: "audio/mp3" });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);

        await new Promise((resolve) => {
            audio.onended = resolve;
            audio.onerror = resolve;
            audio.play().catch(resolve);
        });

        URL.revokeObjectURL(url);
    } catch (e) {
        console.error("Audio playback error:", e);
    }

    isPlaying = false;
    playNextAudio();
}

// Populate language dropdowns
LANGUAGES.forEach((lang) => {
    const label = TTS_LANGUAGES.has(lang.code)
        ? `${lang.name}  \u{1F50A}`
        : lang.name;
    sourceSelect.add(new Option(label, lang.code));
    targetSelect.add(new Option(label, lang.code));
});
sourceSelect.value = "hi-IN";
targetSelect.value = "en-IN";

// Check browser support
if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    statusEl.textContent = "Error: Microphone access not available. Use Chrome/Firefox on localhost.";
} else if (!window.AudioWorkletNode) {
    statusEl.textContent = "Error: AudioWorklet not supported. Please use a modern browser.";
} else {
    micBtn.disabled = false;
    statusEl.textContent = "Ready. Select languages and press Start.";
}

// Swap languages
swapBtn.addEventListener("click", () => {
    const tmp = sourceSelect.value;
    sourceSelect.value = targetSelect.value;
    targetSelect.value = tmp;
});

// Mic button
micBtn.addEventListener("click", async () => {
    if (!isRecording) {
        await startRecording();
    } else {
        stopRecording();
    }
});

async function startRecording() {
    transcriptEl.textContent = "";
    translationEl.textContent = "";
    audioQueue.length = 0;

    const srcName = LANGUAGES.find((l) => l.code === sourceSelect.value)?.name;
    const tgtName = LANGUAGES.find((l) => l.code === targetSelect.value)?.name;
    heardLangEl.textContent = `(${srcName})`;
    translatedLangEl.textContent = `(${tgtName})`;

    micBtn.disabled = true;
    statusEl.textContent = "Requesting microphone access...";

    try {
        // Step 1: Get microphone FIRST
        mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true,
            },
        });

        statusEl.textContent = "Setting up audio processing...";

        // Step 2: Set up AudioContext + AudioWorklet
        audioContext = new AudioContext();
        await audioContext.audioWorklet.addModule("/static/audio-processor.js");

        sourceNode = audioContext.createMediaStreamSource(mediaStream);
        workletNode = new AudioWorkletNode(audioContext, "audio-processor");

        // Step 3: Connect WebSocket to backend
        statusEl.textContent = "Connecting to translation service...";

        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        websocket = new WebSocket(`${protocol}//${window.location.host}/ws/translate`);
        websocket.binaryType = "arraybuffer";

        await new Promise((resolve, reject) => {
            websocket.onopen = resolve;
            websocket.onerror = () => reject(new Error("WebSocket connection failed"));
            setTimeout(() => reject(new Error("WebSocket connection timeout")), 10000);
        });

        // Send config with TTS preference
        websocket.send(
            JSON.stringify({
                type: "config",
                source_language: sourceSelect.value,
                target_language: targetSelect.value,
                tts_enabled: ttsToggle.checked,
                speaker: voiceSelect.value,
            })
        );

        // Set up message handler
        websocket.onmessage = (event) => {
            const data = JSON.parse(event.data);
            switch (data.type) {
                case "vad":
                    if (data.event === "start") {
                        statusEl.textContent = "Speaking...";
                        micBtn.classList.add("speaking");
                    } else if (data.event === "end") {
                        statusEl.textContent = "Processing...";
                        micBtn.classList.remove("speaking");
                    }
                    break;
                case "transcript":
                    transcriptEl.textContent += data.text + "\n";
                    transcriptEl.scrollTop = transcriptEl.scrollHeight;
                    statusEl.textContent = "Listening... speak now";
                    break;
                case "translation":
                    translationEl.textContent += data.text + "\n";
                    translationEl.scrollTop = translationEl.scrollHeight;
                    break;
                case "audio":
                    audioQueue.push(data.data);
                    playNextAudio();
                    break;
                case "status":
                    if (data.message === "listening") {
                        statusEl.textContent = "Listening... speak now";
                    } else if (data.message === "done") {
                        statusEl.textContent = "Done. Press Start to translate again.";
                        finishRecording();
                    } else {
                        statusEl.textContent = data.message;
                    }
                    break;
                case "error":
                    statusEl.textContent = "Error: " + data.message;
                    console.error("Server error:", data.message);
                    break;
            }
        };

        websocket.onerror = (err) => {
            console.error("WebSocket error:", err);
            statusEl.textContent = "Connection error.";
            finishRecording();
        };

        websocket.onclose = () => {
            if (isRecording) {
                statusEl.textContent = "Connection closed.";
                finishRecording();
            }
        };

        // Step 4: Start streaming audio
        workletNode.port.onmessage = (event) => {
            if (websocket && websocket.readyState === WebSocket.OPEN) {
                websocket.send(event.data);
            }
        };

        sourceNode.connect(workletNode);
        workletNode.connect(audioContext.destination);

        // Update UI
        isRecording = true;
        micBtn.disabled = false;
        micBtn.classList.add("recording");
        micLabel.textContent = "Stop";
        sourceSelect.disabled = true;
        targetSelect.disabled = true;
        voiceSelect.disabled = true;
        ttsToggle.disabled = true;
    } catch (err) {
        console.error("Failed to start:", err);
        statusEl.textContent = "Error: " + err.message;
        cleanupResources();
        micBtn.disabled = false;
    }
}

function stopRecording() {
    if (websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify({ type: "stop" }));
    }
    statusEl.textContent = "Processing final audio...";
    finishRecording();
}

function finishRecording() {
    isRecording = false;
    micBtn.classList.remove("recording");
    micBtn.classList.remove("speaking");
    micLabel.textContent = "Start";
    micBtn.disabled = false;
    sourceSelect.disabled = false;
    targetSelect.disabled = false;
    voiceSelect.disabled = false;
    ttsToggle.disabled = false;

    cleanupResources();

    // Close WebSocket after a brief delay to receive final messages
    const ws = websocket;
    websocket = null;
    setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.close();
        }
        if (statusEl.textContent.startsWith("Processing")) {
            statusEl.textContent = "Done. Press Start to translate again.";
        }
    }, 2000);
}

function cleanupResources() {
    if (sourceNode) {
        sourceNode.disconnect();
        sourceNode = null;
    }
    if (workletNode) {
        workletNode.disconnect();
        workletNode = null;
    }
    if (audioContext && audioContext.state !== "closed") {
        audioContext.close();
        audioContext = null;
    }
    if (mediaStream) {
        mediaStream.getTracks().forEach((t) => t.stop());
        mediaStream = null;
    }
}
