/** One bounded PCM recording, encoded as WAV only after Stop. No network streaming. */
const MAX_BYTES = 25_000_000;

export const encodeMonoWav = (samples: readonly Float32Array[], sampleRate: number): Blob => {
  const count = samples.reduce((total, part) => total + part.length, 0);
  if (!count || 44 + count * 2 > MAX_BYTES) throw new Error("Empty or oversized recording.");
  const buffer = new ArrayBuffer(44 + count * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, count * 2, true);
  let offset = 44;
  for (const part of samples)
    for (const value of part) {
      const sample = Math.max(-1, Math.min(1, value));
      view.setInt16(offset, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
      offset += 2;
    }
  return new Blob([buffer], { type: "audio/wav" });
};

const workletSource = `
class RecordingProcessor extends AudioWorkletProcessor {
  constructor() {
    super(); this.buffer = new Float32Array(8192); this.used = 0; this.active = true;
    this.energy = 0; this.meterSamples = 0;
    this.port.onmessage = () => { this.flush(); this.active = false; this.port.postMessage({ done: true }); };
  }
  flush() { if (this.used) { const data = this.buffer.slice(0, this.used); this.port.postMessage({ samples: data }, [data.buffer]); this.used = 0; } }
  process(inputs) {
    if (!this.active) return false;
    const channels = inputs[0];
    if (channels?.length) for (let i = 0; i < channels[0].length; i++) {
      let sample = 0; for (const channel of channels) sample += channel[i];
      sample /= channels.length;
      this.buffer[this.used++] = sample;
      this.energy += sample * sample; this.meterSamples++;
      if (this.used === this.buffer.length) this.flush();
    }
    if (this.meterSamples >= sampleRate / 16) {
      this.port.postMessage({ level: Math.sqrt(this.energy / this.meterSamples) });
      this.energy = 0; this.meterSamples = 0;
    }
    return true;
  }
}
registerProcessor("assistant-recording", RecordingProcessor);`;

export const startAudioRecording = async (onLimit: () => void, onLevel?: (rms: number) => void) => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  let context: AudioContext | undefined;
  let node: AudioWorkletNode | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  const samples: Float32Array[] = [];
  let count = 0;
  let limitNotified = false;
  let stopped: Promise<Blob> | undefined;
  let finish: (() => void) | undefined;
  let disposed = false;
  const cleanup = () => {
    disposed = true;
    stream.getTracks().forEach((track) => track.stop());
    source?.disconnect();
    node?.disconnect();
    node?.port.close();
    void context?.close();
  };
  try {
    context = new AudioContext();
    const url = URL.createObjectURL(new Blob([workletSource], { type: "text/javascript" }));
    try {
      await context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    node = new AudioWorkletNode(context, "assistant-recording");
    const maxSamples = Math.floor((MAX_BYTES - 44) / 2);
    node.port.onmessage = (event: MessageEvent<{ samples?: Float32Array; done?: boolean; level?: number }>) => {
      if (disposed) return;
      if (event.data.level !== undefined) onLevel?.(event.data.level);
      if (event.data.samples) {
        const part = event.data.samples.subarray(0, Math.max(0, maxSamples - count));
        samples.push(part);
        count += part.length;
        if (count >= maxSamples && !limitNotified) {
          limitNotified = true;
          onLimit();
        }
      }
      if (event.data.done) finish?.();
    };
    source = context.createMediaStreamSource(stream);
    source.connect(node);
    node.connect(context.destination); // Processor outputs silence.
    await context.resume();
    return {
      stop: (): Promise<Blob> =>
        (stopped ??= (async () => {
          try {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error("Recording did not finish.")), 2_000);
              finish = () => {
                clearTimeout(timer);
                resolve();
              };
              node?.port.postMessage({ stop: true });
            });
          } finally {
            cleanup();
          }
          return encodeMonoWav(samples, context!.sampleRate);
        })()),
      discard: cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
};
