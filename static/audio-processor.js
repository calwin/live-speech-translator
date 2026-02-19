class AudioProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.bufferSize = 2048;
        this.buffer = new Float32Array(this.bufferSize);
        this.bufferIndex = 0;
    }

    process(inputs) {
        const input = inputs[0];
        if (!input || !input[0]) return true;

        const channelData = input[0];

        for (let i = 0; i < channelData.length; i++) {
            this.buffer[this.bufferIndex++] = channelData[i];

            if (this.bufferIndex >= this.bufferSize) {
                const downsampled = this.downsample(this.buffer, sampleRate, 16000);
                const pcm = this.float32ToInt16(downsampled);
                this.port.postMessage(pcm.buffer, [pcm.buffer]);
                this.buffer = new Float32Array(this.bufferSize);
                this.bufferIndex = 0;
            }
        }

        return true;
    }

    downsample(buffer, inputRate, outputRate) {
        if (inputRate === outputRate) return buffer;
        const ratio = inputRate / outputRate;
        const newLength = Math.floor(buffer.length / ratio);
        const result = new Float32Array(newLength);
        for (let i = 0; i < newLength; i++) {
            result[i] = buffer[Math.floor(i * ratio)];
        }
        return result;
    }

    float32ToInt16(float32Array) {
        const int16Array = new Int16Array(float32Array.length);
        for (let i = 0; i < float32Array.length; i++) {
            const s = Math.max(-1, Math.min(1, float32Array[i]));
            int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        return int16Array;
    }
}

registerProcessor("audio-processor", AudioProcessor);
