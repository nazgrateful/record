// Sends copies of the audio to the page while `on`, for the sound check.
class TapProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.port.onmessage = (e) => { this.on = !!e.data.on; };
  }
  process(inputs) {
    const input = inputs[0];
    if (this.on && input && input[0]) this.port.postMessage(input.map((x) => x.slice()));
    return true;
  }
}
registerProcessor('tap', TapProcessor);
