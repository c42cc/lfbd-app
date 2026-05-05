// GeminiProvider — browser-side Gemini Live API WebSocket client

let _geminiFailureCount = 0;
let _geminiFatalLock = false;

class GeminiProvider {
  static MAX_FAILURES = 3;

  constructor() {
    this.ws = null;
    this._onAudio = null;
    this._onTranscript = null;
    this._onThinking = null;
    this._onState = null;
    this._connected = false;
    this._errorFired = false;
    this._keepaliveTimer = null;
    this._staleCount = 0;
  }

  static resetFailures() {
    _geminiFailureCount = 0;
    _geminiFatalLock = false;
  }

  onAudioReceived(cb) { this._onAudio = cb; }
  onTranscript(cb) { this._onTranscript = cb; }
  onThinking(cb) { this._onThinking = cb; }
  onStateChange(cb) { this._onState = cb; }

  async connect(token, systemPrompt, opts) {
    if (_geminiFatalLock) {
      this._emitState('fatal');
      return Promise.reject(new Error('Connection aborted — too many failures. Tap to retry.'));
    }

    this._emitState('connecting');

    const model = (opts && opts.model) || 'gemini-2.5-flash-native-audio-preview';
    const voiceName = (opts && opts.voice) || 'Aoede';
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${token}`;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      const connectTimeout = setTimeout(() => {
        if (this.ws) this.ws.close();
        reject(new Error('Connection timed out'));
      }, 10000);

      this.ws.onopen = () => {
        clearTimeout(connectTimeout);
        const setup = {
          setup: {
            model: `models/${model}`,
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName }
                }
              }
            },
            systemInstruction: {
              parts: [{ text: systemPrompt || '' }]
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {}
          }
        };
        this.ws.send(JSON.stringify(setup));
        this._connected = true;
        this._startKeepalive();
        this._emitState('listening');
        resolve();
      };

      this.ws.onmessage = async (event) => {
        try {
          let text;
          if (event.data instanceof Blob) {
            text = await event.data.text();
          } else {
            text = event.data;
          }
          const msg = JSON.parse(text);
          this._handleMessage(msg);
        } catch (err) {
          console.error('Gemini message parse error:', err);
        }
      };

      this.ws.onerror = (err) => {
        clearTimeout(connectTimeout);
        console.error('Gemini WS error:', err);
        this._errorFired = true;
        reject(new Error('WebSocket connection failed'));
      };

      this.ws.onclose = (ev) => {
        this._stopKeepalive();
        this._connected = false;
        const wasError = this._errorFired || !ev.wasClean;
        this._errorFired = false;
        if (wasError) {
          _geminiFailureCount++;
          if (_geminiFailureCount >= GeminiProvider.MAX_FAILURES) {
            _geminiFatalLock = true;
            this._emitState('fatal');
            return;
          }
          this._emitState('error');
        }
        this._emitState('disconnected');
      };
    });
  }

  _handleMessage(msg) {
    if (msg.serverContent) {
      const sc = msg.serverContent;

      // Model audio chunks
      if (sc.modelTurn && sc.modelTurn.parts) {
        for (const part of sc.modelTurn.parts) {
          if (part.inlineData && part.inlineData.data) {
            this._emitState('speaking');
            if (this._onAudio) this._onAudio(part.inlineData.data);
          }
        }
      }

      // Turn complete
      if (sc.turnComplete) {
        this._emitState('listening');
      }

    }

    if (msg.outputTranscription && msg.outputTranscription.text) {
      if (this._onTranscript) {
        this._onTranscript({ role: 'assistant', text: msg.outputTranscription.text });
      }
    }

    if (msg.inputTranscription && msg.inputTranscription.text) {
      if (this._onTranscript) {
        this._onTranscript({ role: 'user', text: msg.inputTranscription.text });
      }
    }

    if (msg.setupComplete) {
      this._emitState('listening');
    }
  }

  sendAudio(base64Pcm) {
    if (!this._connected || !this.ws) return;
    this.ws.send(JSON.stringify({
      realtimeInput: {
        mediaChunks: [{
          mimeType: 'audio/pcm;rate=16000',
          data: base64Pcm
        }]
      }
    }));
  }

  sendText(text) {
    if (!this._connected || !this.ws) return;
    this.ws.send(JSON.stringify({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text }] }],
        turnComplete: true
      }
    }));
  }

  disconnect() {
    this._stopKeepalive();
    this._connected = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  _startKeepalive() {
    this._stopKeepalive();
    this._staleCount = 0;
    this._keepaliveTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (this.ws.bufferedAmount > 0) {
        this._staleCount++;
        if (this._staleCount >= 2) {
          console.warn('Gemini keepalive: send buffer stalled, closing');
          this.ws.close();
        }
      } else {
        this._staleCount = 0;
      }
    }, 30000);
  }

  _stopKeepalive() {
    if (this._keepaliveTimer) {
      clearInterval(this._keepaliveTimer);
      this._keepaliveTimer = null;
    }
  }

  _emitState(s) {
    if (this._onState) this._onState(s);
  }
}
