// GrokProvider — browser-side Grok Voice Agent API WebSocket client

class GrokProvider {
  constructor() {
    this.ws = null;
    this._onAudio = null;
    this._onTranscript = null;
    this._onThinking = null;
    this._onState = null;
    this._connected = false;
    this._currentAudioTranscript = '';
    this._currentThinkingText = '';
  }

  onAudioReceived(cb) { this._onAudio = cb; }
  onTranscript(cb) { this._onTranscript = cb; }
  onThinking(cb) { this._onThinking = cb; }
  onStateChange(cb) { this._onState = cb; }

  async connect(token, systemPrompt) {
    this._emitState('connecting');

    const model = 'grok-voice-think-fast-1.0';
    const url = `wss://api.x.ai/v1/realtime?model=${model}`;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url, [`xai-client-secret.${token}`]);

      this.ws.onopen = () => {
        // Send session config
        this.ws.send(JSON.stringify({
          type: 'session.update',
          session: {
            voice: 'eve',
            instructions: systemPrompt || '',
            turn_detection: { type: 'server_vad' },
            input_audio_format: 'pcm16',
            output_audio_format: 'pcm16',
            input_audio_transcription: { model: 'grok-2-public' }
          }
        }));

        this._connected = true;
        this._emitState('listening');
        resolve();
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this._handleMessage(msg);
        } catch (err) {
          console.error('Grok message parse error:', err);
        }
      };

      this.ws.onerror = (err) => {
        console.error('Grok WS error:', err);
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
    switch (msg.type) {
      case 'session.created':
      case 'session.updated':
        this._emitState('listening');
        break;

      case 'response.audio.delta':
      case 'response.output_audio.delta':
        this._emitState('speaking');
        if (msg.delta && this._onAudio) {
          this._onAudio(msg.delta);
        }
        break;

      // Thinking / reasoning text (grok-voice-think-fast model)
      case 'response.text.delta':
        if (msg.delta) {
          this._currentThinkingText += msg.delta;
        }
        break;

      case 'response.text.done':
        if (this._currentThinkingText.trim() && this._onThinking) {
          this._onThinking(this._currentThinkingText.trim());
        }
        this._currentThinkingText = '';
        break;

      // Actual spoken audio transcript (what the AI said out loud)
      case 'response.audio_transcript.delta':
      case 'response.output_audio_transcript.delta':
        if (msg.delta) {
          this._currentAudioTranscript += msg.delta;
        }
        break;

      case 'response.audio_transcript.done':
      case 'response.output_audio_transcript.done':
        if (this._currentAudioTranscript.trim() && this._onTranscript) {
          this._onTranscript({
            role: 'assistant',
            text: this._currentAudioTranscript.trim()
          });
        }
        this._currentAudioTranscript = '';
        break;

      // User speech transcript
      case 'conversation.item.input_audio_transcription.completed':
        if (msg.transcript && msg.transcript.trim() && this._onTranscript) {
          this._onTranscript({ role: 'user', text: msg.transcript.trim() });
        }
        break;

      case 'response.done':
        this._flushThinking();
        this._emitState('listening');
        break;

      case 'input_audio_buffer.speech_started':
        this._emitState('listening');
        break;

      case 'error':
        console.error('Grok error event:', msg.error);
        this._emitState('error');
        break;
    }
  }

  _flushThinking() {
    if (this._currentThinkingText.trim() && this._onThinking) {
      this._onThinking(this._currentThinkingText.trim());
    }
    this._currentThinkingText = '';
  }

  sendAudio(base64Pcm) {
    if (!this._connected || !this.ws) return;
    this.ws.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: base64Pcm
    }));
  }

  sendText(text) {
    if (!this._connected || !this.ws) return;
    this.ws.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }]
      }
    }));
    this.ws.send(JSON.stringify({ type: 'response.create' }));
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
