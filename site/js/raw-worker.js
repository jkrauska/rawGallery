/**
 * Web Worker for decoding RAW camera files (ARW, CR2, NEF, DNG, etc.)
 * using LibRaw-Wasm.
 *
 * Messages:
 *   { type: 'decode', buffer: ArrayBuffer }
 *   -> { pixels: ArrayBuffer, width: number, height: number }
 *   -> { error: string }
 */

let libraw = null;

async function loadLibRaw() {
  if (libraw) return libraw;
  try {
    const module = await import('https://cdn.jsdelivr.net/npm/libraw-wasm@1.1.2/dist/libraw.mjs');
    libraw = module.default || module;
    if (typeof libraw.init === 'function') {
      await libraw.init();
    }
    return libraw;
  } catch (e) {
    throw new Error('Failed to load LibRaw-Wasm: ' + e.message);
  }
}

self.onmessage = async function(e) {
  const { type, buffer } = e.data;

  if (type !== 'decode') {
    self.postMessage({ error: 'Unknown message type' });
    return;
  }

  try {
    const LibRaw = await loadLibRaw();
    const raw = new LibRaw();
    await raw.open(new Uint8Array(buffer));
    const meta = await raw.metadata();
    const imageData = await raw.imageData();

    // imageData contains { data: Uint8Array (RGBA), width, height }
    // Convert RGBA to RGBA clamped array for ImageData
    const pixels = imageData.data.buffer;

    self.postMessage(
      {
        pixels,
        width: imageData.width || meta.width,
        height: imageData.height || meta.height,
      },
      [pixels]
    );

    raw.close();
  } catch (err) {
    self.postMessage({ error: 'RAW decode failed: ' + err.message });
  }
};
