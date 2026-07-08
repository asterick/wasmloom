/** Error thrown for all invalid wasmemit API usage and emit-time failures. */
export class WasmEmitError extends Error {
  /**
   * @param {string} message
   * @param {string} [trace] creation-site stack captured in debug mode
   */
  constructor(message, trace) {
    super(trace ? `${message}\nCreated at:\n${trace}` : message);
    this.name = "WasmEmitError";
  }
}

/**
 * @param {string} message
 * @param {{trace?: string}} [source] object that may carry a debug trace
 * @returns {never}
 */
export function fail(message, source) {
  throw new WasmEmitError(message, source?.trace);
}
