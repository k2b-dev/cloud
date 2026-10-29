/** Decoder seam only. Shared QrScanner owns camera errors, validation and cleanup. */
export default class SyntheticDecoder {
  static NO_QR_CODE_FOUND = "No QR code found";
  private readonly listener: (event: Event) => void;
  constructor(
    private readonly video: HTMLVideoElement,
    onResult: (value: { data: string }) => void,
  ) {
    this.listener = (event) => {
      if (event instanceof CustomEvent && typeof event.detail === "string") onResult({ data: event.detail });
    };
  }
  /** Like qr-scanner, start() plays the stream already set on the video and resolves once it plays. */
  async start() {
    window.addEventListener("fixture:decoded-qr", this.listener);
    await this.video.play();
  }
  async pause() {
    window.removeEventListener("fixture:decoded-qr", this.listener);
  }
  destroy() {
    window.removeEventListener("fixture:decoded-qr", this.listener);
  }
}
