// AudioWorklet processor: captures mic audio, resamples, outputs Int16 PCM chunks

class PcmProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = options.processorOptions?.targetRate || 16000;
    this.buffer = [];
    this.chunkSize = Math.floor(this.targetRate * 0.1);
    this.step = Math.round(sampleRate / this.targetRate);
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const samples = input[0];

    for (let i = 0; i < samples.length; i += this.step) {
      const clamped = Math.max(-1, Math.min(1, samples[i]));
      this.buffer.push(clamped * 0x7FFF | 0);
    }

    // Emit when we have enough for a chunk
    while (this.buffer.length >= this.chunkSize) {
      const chunk = new Int16Array(this.buffer.splice(0, this.chunkSize));
      this.port.postMessage({ pcm: chunk.buffer }, [chunk.buffer]);
    }

    return true;
  }
}

registerProcessor('pcm-processor', PcmProcessor);
