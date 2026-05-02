// GeminiProvider — browser-side Gemini Live API WebSocket client

class GeminiProvider {
  constructor() {
    this.ws = null;
    this._onAudio = null;
    this._onTranscript = null;
    this._onThinking = null;
    this._onState = null;
    this._connected = false;
  }

  onAudioReceived(cb) { this._onAudio = cb; }
  onTranscript(cb) { this._onTranscript = cb; }
  onThinking(cb) { this._onThinking = cb; }
  onStateChange(cb) { this._onState = cb; }

  async connect(token, systemPrompt) {
    this._emitState('connecting');

    const model = 'gemini-2.5-flash-native-audio-preview-12-2025';
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${token}`;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        // Send setup message
        const setup = {
          setup: {
            model: `models/${model}`,
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: 'Aoede' }
                }
              }
            },
            systemInstruction: {
              parts: [{ text: systemPrompt || '' }]
            }
          }
        };
        this.ws.send(JSON.stringify(setup));
        this._connected = true;
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
        console.error('Gemini WS error:', err);
        this._emitState('error');
        reject(new Error('WebSocket connection failed'));
      };

      this.ws.onclose = () => {
        this._connected = false;
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

      // AI speech transcript (what the model actually said aloud)
      if (sc.outputTranscript) {
        if (this._onTranscript) {
          this._onTranscript({ role: 'assistant', text: sc.outputTranscript });
        }
      }

      // User speech transcript (what Gemini heard the user say)
      if (sc.inputTranscript) {
        if (this._onTranscript) {
          this._onTranscript({ role: 'user', text: sc.inputTranscript });
        }
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
    this._connected = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  _emitState(s) {
    if (this._onState) this._onState(s);
  }
}
