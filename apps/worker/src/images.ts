import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import type { ImageInput } from '@places/core';
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export class SmokeImageFailure extends Error {
  constructor(
    readonly code:
      | 'vision_smoke_usage:expected_one_image'
      | 'vision_smoke_unsupported_image'
      | 'vision_smoke_image_too_large'
      | 'vision_smoke_image_unreadable',
  ) {
    super(code);
    this.name = 'SmokeImageFailure';
  }
}
export function imageFromBytes(bytes: Uint8Array): ImageInput {
  if (bytes.byteLength > MAX_IMAGE_BYTES)
    throw new SmokeImageFailure('vision_smoke_image_too_large');
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const mimeType =
    b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
      ? 'image/jpeg'
      : b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? 'image/png'
        : b.toString('ascii', 0, 4) === 'RIFF' &&
            b.toString('ascii', 8, 12) === 'WEBP'
          ? 'image/webp'
          : undefined;
  if (!mimeType) throw new SmokeImageFailure('vision_smoke_unsupported_image');
  return { mimeType, bytes };
}
export async function loadSmokeImage(
  args: readonly string[],
): Promise<ImageInput> {
  if (args.length !== 1 || !args[0])
    throw new SmokeImageFailure('vision_smoke_usage:expected_one_image');
  const expected = new Map([
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.png', 'image/png'],
    ['.webp', 'image/webp'],
  ]).get(extname(args[0]).toLowerCase());
  if (!expected) throw new SmokeImageFailure('vision_smoke_unsupported_image');
  let file;
  try {
    file = await open(args[0], 'r');
  } catch {
    throw new SmokeImageFailure('vision_smoke_image_unreadable');
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile())
      throw new SmokeImageFailure('vision_smoke_image_unreadable');
    if (stat.size > MAX_IMAGE_BYTES)
      throw new SmokeImageFailure('vision_smoke_image_too_large');
    // Bound the read too: a file can grow between stat and read.
    const buffer = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        size,
        buffer.length - size,
        null,
      );
      if (!bytesRead) break;
      size += bytesRead;
    }
    const image = imageFromBytes(buffer.subarray(0, size));
    if (image.mimeType !== expected)
      throw new SmokeImageFailure('vision_smoke_unsupported_image');
    return image;
  } catch (error) {
    if (error instanceof SmokeImageFailure) throw error;
    throw new SmokeImageFailure('vision_smoke_image_unreadable');
  } finally {
    await file.close();
  }
}
