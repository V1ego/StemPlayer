/* SoundTouch AudioWorklet processor.
 * Provides INDEPENDENT tempo (speed) and pitch (cents) by running the
 * SoundTouch phase-vocoder on each channel. Loaded via
 *   ctx.audioWorklet.addModule('/static/js/soundtouch-processor.js')
 * The vendored classic build is imported with an absolute path so it resolves
 * regardless of the worklet base-URL quirk.
 *
 * If SoundTouch fails to load inside the worklet the processor still registers
 * but reports hasST=false on a 'ping' so the engine can fall back to native
 * tape-varispeed (playbackRate).
 */

// Absolute path: Flask serves /static/... at the site root on 127.0.0.1:5000.
const ST_URL = '/static/js/vendor/soundtouch-worklet.js';
try {
  importScripts(ST_URL);
} catch (e) {
  // SoundTouch unavailable; processor will passthrough.
}

class SoundTouchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'tempo', defaultValue: 1.0, minValue: 0.25, maxValue: 4.0, automationRate: 'k-rate' },
      { name: 'pitch', defaultValue: 0.0, minValue: -1200, maxValue: 1200, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.st = (typeof SoundTouch !== 'undefined') ? new SoundTouch() : null;
    this.fifo = (typeof FifoSampleBuffer !== 'undefined') ? new FifoSampleBuffer() : null;
    this._lastTempo = 1.0;
    this._lastPitch = 1.0;

    // Respond to engine readiness probe (race-free: only replies after ping).
    this.port.onmessage = (e) => {
      if (e.data === 'ping') {
        this.port.postMessage({ type: 'ready', hasST: !!this.st });
      }
    };
  }

  _applyParams(tempo, pitchCents) {
    if (!this.st) return;
    const pitchRatio = Math.pow(2, pitchCents / 1200);
    if (tempo !== this._lastTempo) { this.st.tempo = tempo; this._lastTempo = tempo; }
    if (pitchRatio !== this._lastPitch) { this.st.pitch = pitchRatio; this._lastPitch = pitchRatio; }
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const outL = output[0];
    const outR = output.length > 1 ? output[1] : output[0];
    const numFrames = outL.length; // typically 128

    // Passthrough when SoundTouch is unavailable.
    if (!this.st || !this.fifo) {
      if (input && input.length > 0) {
        const inL = input[0], inR = input.length > 1 ? input[1] : input[0];
        for (let i = 0; i < numFrames; i++) { outL[i] = inL[i]; outR[i] = inR[i]; }
      } else {
        for (let i = 0; i < numFrames; i++) { outL[i] = 0; outR[i] = 0; }
      }
      return true;
    }

    const tempo = parameters.tempo[0];
    const pitchCents = parameters.pitch[0];
    this._applyParams(tempo, pitchCents);

    // Feed interleaved stereo input into SoundTouch.
    if (input && input.length > 0) {
      const inL = input[0];
      const inR = input.length > 1 ? input[1] : input[0];
      const inter = new Float32Array(numFrames * 2);
      for (let i = 0; i < numFrames; i++) { inter[i * 2] = inL[i]; inter[i * 2 + 1] = inR[i]; }
      this.st._inputBuffer.putSamples(inter, 0, numFrames);
    }
    this.st.process();

    // Drain processed output into our FIFO.
    let avail = this.st._outputBuffer.frameCount;
    while (avail > 0) {
      const tmp = new Float32Array(avail * 2);
      this.st._outputBuffer.receiveSamples(tmp, avail);
      this.fifo.putSamples(tmp, 0, avail);
      avail = this.st._outputBuffer.frameCount;
    }

    // Emit exactly numFrames from the FIFO, silence-filling shortfalls.
    const have = this.fifo.frameCount;
    const take = Math.min(have, numFrames);
    if (take > 0) {
      const deinter = new Float32Array(take * 2);
      this.fifo.receiveSamples(deinter, take);
      for (let i = 0; i < take; i++) { outL[i] = deinter[i * 2]; outR[i] = deinter[i * 2 + 1]; }
    }
    for (let i = take; i < numFrames; i++) { outL[i] = 0; outR[i] = 0; }
    return true;
  }
}

registerProcessor('soundtouch-processor', SoundTouchProcessor);
