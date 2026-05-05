// AudioManager — mic capture to PCM + PCM playback

class AudioManager {
  static NOISE_FLOOR_RMS = 400;

  constructor() {
    this.captureCtx = null;
    this.captureStream = null;
    this.workletNode = null;
    this.playbackCtx = null;
    this.playbackQueue = [];
    this.isPlaying = false;
    this.nextPlayTime = 0;

    this._lastSoundTime = 0;
    this._silenceThresholdMs = 10000;
    this._silenceFired = false;
    this._onSilenceCb = null;
    this._silenceCheckInterval = null;
    this._squelchAfterMs = 2000;
  }

  onSilence(cb, thresholdMs = 10000) {
    this._onSilenceCb = cb;
    this._silenceThresholdMs = thresholdMs;
  }

  async startCapture(targetSampleRate, onPcmChunk) {
    this.captureStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: { ideal: 48000 }
      }
    });

    this.captureCtx = new AudioContext({ sampleRate: 48000 });
    await this.captureCtx.audioWorklet.addModule('/pcm-processor.js');

    const source = this.captureCtx.createMediaStreamSource(this.captureStream);

    this.workletNode = new AudioWorkletNode(this.captureCtx, 'pcm-processor', {
      processorOptions: { targetRate: targetSampleRate }
    });

    this._lastSoundTime = Date.now();
    this._silenceFired = false;

    this.workletNode.port.onmessage = (e) => {
      if (e.data.pcm) {
        const int16 = new Int16Array(e.data.pcm);

        let sumSq = 0;
        for (let i = 0; i < int16.length; i++) {
          sumSq += int16[i] * int16[i];
        }
        const rms = Math.sqrt(sumSq / int16.length);

        if (rms > AudioManager.NOISE_FLOOR_RMS) {
          this._lastSoundTime = Date.now();
          this._silenceFired = false;
        }

        if (Date.now() - this._lastSoundTime < this._squelchAfterMs) {
          const base64 = this._int16ToBase64(int16);
          onPcmChunk(base64);
        }
      }
    };

    source.connect(this.workletNode);

    this._silenceCheckInterval = setInterval(() => {
      if (
        this._onSilenceCb &&
        !this._silenceFired &&
        Date.now() - this._lastSoundTime >= this._silenceThresholdMs
      ) {
        this._silenceFired = true;
        this._onSilenceCb();
      }
    }, 1000);
  }

  stopCapture() {
    if (this._silenceCheckInterval) {
      clearInterval(this._silenceCheckInterval);
      this._silenceCheckInterval = null;
    }
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.captureStream) {
      this.captureStream.getTracks().forEach(t => t.stop());
      this.captureStream = null;
    }
    if (this.captureCtx) {
      this.captureCtx.close();
      this.captureCtx = null;
    }
  }

  playPcmChunk(base64Pcm, sampleRate) {
    if (!this.playbackCtx) {
      this.playbackCtx = new AudioContext({ sampleRate });
    }

    const int16 = this._base64ToInt16(base64Pcm);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 0x7FFF;
    }

    const buffer = this.playbackCtx.createBuffer(1, float32.length, sampleRate);
    buffer.getChannelData(0).set(float32);

    const source = this.playbackCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.playbackCtx.destination);

    // Schedule for gapless playback
    const now = this.playbackCtx.currentTime;
    if (this.nextPlayTime < now) {
      this.nextPlayTime = now + 0.01; // tiny offset to avoid click
    }

    source.start(this.nextPlayTime);
    this.nextPlayTime += buffer.duration;
  }

  stopPlayback() {
    if (this.playbackCtx) {
      this.playbackCtx.close();
      this.playbackCtx = null;
    }
    this.nextPlayTime = 0;
  }

  _int16ToBase64(int16Array) {
    const bytes = new Uint8Array(int16Array.buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  _base64ToInt16(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Int16Array(bytes.buffer);
  }
}
