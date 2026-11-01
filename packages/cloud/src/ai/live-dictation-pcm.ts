/** Stateful linear resampling to 16 kHz, emitting little-endian PCM16 in 100 ms frames. */
export function createDictationPcmEncoder(inputRate: number, emit: (frame: ArrayBuffer, level: number) => void) {
  const step = inputRate / 16_000;
  let inputIndex = 0;
  let nextOutput = 0;
  let previous = 0;
  let frame = new ArrayBuffer(3200);
  let view = new DataView(frame);
  let offset = 0;
  let squares = 0;
  const encode = (samples: Float32Array) => {
    for (const sample of samples) {
      while (nextOutput <= inputIndex) {
        const fraction = inputIndex === 0 ? 1 : nextOutput - (inputIndex - 1);
        const value = Math.max(-1, Math.min(1, previous + (sample - previous) * fraction));
        view.setInt16(offset, Math.round(value * (value < 0 ? 32768 : 32767)), true);
        offset += 2;
        squares += value * value;
        if (offset === 3200) {
          emit(frame, Math.min(1, Math.sqrt(squares / 1600)));
          frame = new ArrayBuffer(3200);
          view = new DataView(frame);
          offset = 0;
          squares = 0;
        }
        nextOutput += step;
      }
      previous = sample;
      inputIndex++;
    }
  };
  return Object.assign(encode, {
    flush() {
      if (!offset) return;
      emit(frame.slice(0, offset), Math.min(1, Math.sqrt(squares / (offset / 2))));
      frame = new ArrayBuffer(3200);
      view = new DataView(frame);
      offset = 0;
      squares = 0;
    },
  });
}

export const liveDictationWorklet = () => `
const encoder = ${createDictationPcmEncoder.toString()};
class DictationProcessor extends AudioWorkletProcessor {
  constructor() {
    super(); this.active = true;
    this.encode = encoder(sampleRate, (frame, level) => this.port.postMessage({ frame, level }, [frame]));
    this.port.onmessage = () => { this.encode.flush(); this.active = false; this.port.postMessage({ done: true }); };
  }
  process(inputs) { if (!this.active) return false; if (inputs[0]?.[0]) this.encode(inputs[0][0]); return true; }
}
registerProcessor('cloud-live-dictation', DictationProcessor);
`;
