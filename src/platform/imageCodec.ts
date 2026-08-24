/**
 * The encoder Compress borrows from the browser.
 *
 * This is the half of Compress that cannot live in the engine: turning pixels
 * back into bytes needs a canvas, and the engine has no DOM by design. It sits
 * here, is handed in at the worker boundary, and is the only piece of the tool
 * a Node test cannot run — which is why the engine keeps every decision on its
 * own side of the line and this file makes none.
 */
import type { ImageToRecode, RecodedImage } from '../engine/types';

/**
 * Straight to RGBA, because that is the only thing ImageData holds.
 *
 * A grey scan therefore triples on the way in. It costs nothing on the way out
 * — JPEG throws most of the colour away again — and it means one code path
 * instead of two, with no chance of the grey one quietly rotting.
 */
function toRgba(bytes: Uint8Array, components: 1 | 3, pixels: number): Uint8ClampedArray<ArrayBuffer> {
  // Backed by a plain ArrayBuffer explicitly: ImageData will not take a view
  // that might be sitting on shared memory.
  const rgba = new Uint8ClampedArray(new ArrayBuffer(pixels * 4));
  if (components === 1) {
    for (let i = 0; i < pixels; i++) {
      const v = bytes[i];
      rgba[i * 4] = v;
      rgba[i * 4 + 1] = v;
      rgba[i * 4 + 2] = v;
      rgba[i * 4 + 3] = 255;
    }
  } else {
    for (let i = 0; i < pixels; i++) {
      rgba[i * 4] = bytes[i * 3];
      rgba[i * 4 + 1] = bytes[i * 3 + 1];
      rgba[i * 4 + 2] = bytes[i * 3 + 2];
      rgba[i * 4 + 3] = 255;
    }
  }
  return rgba;
}

async function sourceBitmap(image: ImageToRecode): Promise<ImageBitmap> {
  if (image.source.kind === 'jpeg') {
    // A copy, because the Blob would otherwise hold on to the document's own
    // buffer for as long as the bitmap lives.
    const blob = new Blob([new Uint8Array(image.source.bytes)], { type: 'image/jpeg' });
    return createImageBitmap(blob);
  }
  const rgba = toRgba(image.source.bytes, image.source.components, image.width * image.height);
  return createImageBitmap(new ImageData(rgba, image.width, image.height));
}

/**
 * Re-encodes one image, or returns null.
 *
 * Null rather than a throw: an image the browser will not decode is a reason to
 * leave that image alone, not a reason to fail somebody's document. The engine
 * counts the nulls and reports them.
 */
export async function recodeImage(image: ImageToRecode): Promise<RecodedImage | null> {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return null;

  const width = Math.max(1, Math.round(image.targetWidth));
  const height = Math.max(1, Math.round(image.targetHeight));

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await sourceBitmap(image);

    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) return null;

    // JPEG has no alpha, so anything not painted comes out black rather than
    // absent. White is what the page behind it would have been.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);

    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: image.quality });
    return {
      format: 'jpeg',
      bytes: new Uint8Array(await blob.arrayBuffer()),
      width,
      height,
      // Canvas writes three-channel JPEG whatever went in, so the dictionary
      // has to say DeviceRGB even for an image that arrived grey.
      components: 3,
    };
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}
