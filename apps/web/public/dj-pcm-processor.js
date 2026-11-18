/* AudioWorklet: emit 48 kHz, stereo, signed 16-bit PCM every 2,048 samples.
 * A single WebSocket uplink reaches the Fly backend, never individual listeners.
 * The output remains silent to avoid monitoring feedback on the DJ's computer.
 */
class VirgoPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.framesPerChunk = 2048;
    this.interleaved = new Int16Array(this.framesPerChunk * 2);
    this.frame = 0;
  }
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (output) {
      for (const channel of output) channel.fill(0);
    }
    if (!input || !input[0]) return true;
    const left = input[0];
    const right = input[1] || left;
    for (let i = 0; i < left.length; i += 1) {
      const a = Math.max(-1, Math.min(1, left[i]));
      const b = Math.max(-1, Math.min(1, right[i]));
      this.interleaved[this.frame * 2] = Math.round(a * (a < 0 ? 32768 : 32767));
      this.interleaved[this.frame * 2 + 1] = Math.round(b * (b < 0 ? 32768 : 32767));
      this.frame += 1;
      if (this.frame === this.framesPerChunk) {
        const raw = this.interleaved.buffer;
        this.port.postMessage(raw, [raw]);
        this.interleaved = new Int16Array(this.framesPerChunk * 2);
        this.frame = 0;
      }
    }
    return true;
  }
}
registerProcessor('virgo-pcm', VirgoPcmProcessor);
