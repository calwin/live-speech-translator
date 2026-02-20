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
const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const fileInfo = document.getElementById("file-info");
const fileName = document.getElementById("file-name");
const fileSize = document.getElementById("file-size");
const removeFileBtn = document.getElementById("remove-file");
const generateBtn = document.getElementById("generate-btn");
const progressSection = document.getElementById("progress-section");
const progressStatus = document.getElementById("progress-status");
const progressBar = document.getElementById("progress-bar");
const progressPercent = document.getElementById("progress-percent");
const videoSection = document.getElementById("video-section");
const videoPlayer = document.getElementById("video-player");
const subtitleTrack = document.getElementById("subtitle-track");
const downloadBtn = document.getElementById("download-vtt");
const resetBtn = document.getElementById("reset-btn");

// State
let selectedFile = null;
let videoObjectUrl = null;
let vttContent = null;
let vttObjectUrl = null;

// Populate language dropdowns
sourceSelect.add(new Option("Auto Detect", "unknown"));
LANGUAGES.forEach((lang) => {
    sourceSelect.add(new Option(lang.name, lang.code));
    targetSelect.add(new Option(lang.name, lang.code));
});
sourceSelect.value = "unknown";
targetSelect.value = "en-IN";

// Format file size
function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

// File selection
function handleFileSelect(file) {
    if (!file || !file.type.startsWith("video/")) {
        alert("Please select a video file.");
        return;
    }
    if (file.size > 200 * 1024 * 1024) {
        alert("File too large. Maximum size is 200MB.");
        return;
    }

    selectedFile = file;
    fileName.textContent = file.name;
    fileSize.textContent = formatSize(file.size);
    dropZone.classList.add("hidden");
    fileInfo.classList.remove("hidden");
    generateBtn.disabled = false;

    // Create object URL for video playback later
    if (videoObjectUrl) URL.revokeObjectURL(videoObjectUrl);
    videoObjectUrl = URL.createObjectURL(file);
}

// Drag and drop
dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
});
dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("dragover");
});
dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    if (e.dataTransfer.files.length) handleFileSelect(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", () => {
    if (fileInput.files.length) handleFileSelect(fileInput.files[0]);
});

// Remove file
removeFileBtn.addEventListener("click", () => {
    selectedFile = null;
    fileInput.value = "";
    dropZone.classList.remove("hidden");
    fileInfo.classList.add("hidden");
    generateBtn.disabled = true;
    if (videoObjectUrl) {
        URL.revokeObjectURL(videoObjectUrl);
        videoObjectUrl = null;
    }
});

// Generate subtitles
generateBtn.addEventListener("click", startProcessing);

async function startProcessing() {
    if (!selectedFile) return;

    // Disable controls
    generateBtn.disabled = true;
    sourceSelect.disabled = true;
    targetSelect.disabled = true;
    removeFileBtn.disabled = true;

    // Show progress
    progressSection.classList.remove("hidden");
    videoSection.classList.add("hidden");
    updateProgress(5, "Uploading video...");

    try {
        // Upload video
        const formData = new FormData();
        formData.append("file", selectedFile);
        formData.append("source_lang", sourceSelect.value);
        formData.append("target_lang", targetSelect.value);

        const response = await fetch("/api/subtitles/upload", {
            method: "POST",
            body: formData,
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || "Upload failed");
        }

        const { job_id } = await response.json();
        updateProgress(15, "Extracting audio...");

        // Connect WebSocket for progress
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(`${protocol}//${window.location.host}/ws/subtitles/${job_id}`);

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            switch (data.type) {
                case "progress":
                    updateProgress(data.percent, data.message);
                    break;
                case "complete":
                    updateProgress(100, "Subtitles ready!");
                    showResult(data.vtt);
                    ws.close();
                    break;
                case "error":
                    showError(data.message);
                    ws.close();
                    break;
            }
        };

        ws.onerror = () => showError("Connection error");
        ws.onclose = () => enableControls();

    } catch (err) {
        showError(err.message);
        enableControls();
    }
}

function updateProgress(percent, message) {
    progressBar.style.width = percent + "%";
    progressPercent.textContent = percent + "%";
    progressStatus.textContent = message;
}

function showResult(vtt) {
    vttContent = vtt;

    // Clean up previous VTT URL
    if (vttObjectUrl) URL.revokeObjectURL(vttObjectUrl);

    // Create VTT blob URL
    const vttBlob = new Blob([vtt], { type: "text/vtt" });
    vttObjectUrl = URL.createObjectURL(vttBlob);

    // Set up video player
    videoPlayer.src = videoObjectUrl;
    subtitleTrack.src = vttObjectUrl;
    subtitleTrack.srclang = targetSelect.value.split("-")[0];

    // Show video section
    videoSection.classList.remove("hidden");

    // Ensure subtitles are shown by default
    videoPlayer.addEventListener("loadedmetadata", () => {
        if (videoPlayer.textTracks.length > 0) {
            videoPlayer.textTracks[0].mode = "showing";
        }
    }, { once: true });
}

function showError(message) {
    updateProgress(0, "Error: " + message);
    progressBar.style.width = "0%";
    progressPercent.textContent = "";
    enableControls();
}

function enableControls() {
    generateBtn.disabled = !selectedFile;
    sourceSelect.disabled = false;
    targetSelect.disabled = false;
    removeFileBtn.disabled = false;
}

// Download VTT
downloadBtn.addEventListener("click", () => {
    if (!vttContent) return;
    const blob = new Blob([vttContent], { type: "text/vtt" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const baseName = selectedFile ? selectedFile.name.replace(/\.[^.]+$/, "") : "subtitles";
    const targetName = LANGUAGES.find((l) => l.code === targetSelect.value)?.name || "translated";
    a.download = `${baseName}_${targetName}.vtt`;
    a.click();
    URL.revokeObjectURL(url);
});

// Reset / New Video
resetBtn.addEventListener("click", () => {
    // Reset state
    selectedFile = null;
    fileInput.value = "";
    vttContent = null;

    if (videoObjectUrl) {
        URL.revokeObjectURL(videoObjectUrl);
        videoObjectUrl = null;
    }
    if (vttObjectUrl) {
        URL.revokeObjectURL(vttObjectUrl);
        vttObjectUrl = null;
    }

    videoPlayer.src = "";
    subtitleTrack.src = "";

    // Reset UI
    dropZone.classList.remove("hidden");
    fileInfo.classList.add("hidden");
    progressSection.classList.add("hidden");
    videoSection.classList.add("hidden");
    generateBtn.disabled = true;
    updateProgress(0, "");
    enableControls();
});
