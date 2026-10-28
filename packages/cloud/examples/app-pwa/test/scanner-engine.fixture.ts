/** Decoder seam only. Shared QrScanner owns camera errors, validation and cleanup. */
export default class SyntheticDecoder {
  static NO_QR_CODE_FOUND = "No QR code found";
  private readonly listener: (event: Event) => void;
  constructor(_video: HTMLVideoElement, onResult: (value: { data: string }) => void) {
    this.listener = (event) => {
      if (event instanceof CustomEvent && typeof event.detail === "string") onResult({ data: event.detail });
    };
  }
  async start() {
    window.addEventListener("fixture:decoded-qr", this.listener);
  }
  async pause() {
    window.removeEventListener("fixture:decoded-qr", this.listener);
  }
  destroy() {
    window.removeEventListener("fixture:decoded-qr", this.listener);
  }
}
