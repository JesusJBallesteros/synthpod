// Builds the "Info" (Xing) frame that tells players the exact length of a CBR MP3.

const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** MP3 at 24 kHz and below (MPEG-2) tops out at 160 kbps; pick the nearest bitrate the format allows. */
export function effectiveBitrate(sampleRate: number, kbps: number): number {
  const allowed = (sampleRate >= 32000 ? BITRATES_V1 : BITRATES_V2).slice(1);
  return allowed.filter((b) => b <= kbps).pop() ?? allowed[0];
}

interface FrameHeader {
  size: number;
  mpeg1: boolean;
  mono: boolean;
}

/** Decode a Layer III frame header at `offset`, or null if there is none. */
export function readFrameHeader(data: Uint8Array, offset: number): FrameHeader | null {
  if (offset + 4 > data.length || data[offset] !== 0xff || (data[offset + 1] & 0xe0) !== 0xe0) return null;
  const version = (data[offset + 1] >> 3) & 3; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
  const layer = (data[offset + 1] >> 1) & 3; // 1 = Layer III
  const bitrateIndex = data[offset + 2] >> 4;
  const rateIndex = (data[offset + 2] >> 2) & 3;
  const padding = (data[offset + 2] >> 1) & 1;
  if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const mpeg1 = version === 3;
  const kbps = (mpeg1 ? BITRATES_V1 : BITRATES_V2)[bitrateIndex];
  const size = Math.floor(((mpeg1 ? 144 : 72) * kbps * 1000) / RATES[version][rateIndex]) + padding;
  return { size, mpeg1, mono: data[offset + 3] >> 6 === 3 };
}

export function countFrames(data: Uint8Array): number {
  let frames = 0;
  for (let offset = 0; ; frames++) {
    const header = readFrameHeader(data, offset);
    if (!header) return frames;
    offset += header.size;
  }
}

/**
 * Make an Info frame for the given encoded stream. It is itself a valid (silent) MP3 frame with
 * the stream's own header, so players that do not know the tag just skip a few milliseconds.
 */
export function buildInfoFrame(audio: Uint8Array): Uint8Array | null {
  const header = readFrameHeader(audio, 0);
  if (!header) return null;
  const frame = new Uint8Array(header.size - (audio[2] & 2 ? 1 : 0));
  frame.set(audio.subarray(0, 4));
  frame[2] &= ~2; // no padding
  const sideInfo = header.mpeg1 ? (header.mono ? 17 : 32) : header.mono ? 9 : 17;
  const tag = 4 + sideInfo;
  if (tag + 16 > frame.length) return null;
  frame.set([0x49, 0x6e, 0x66, 0x6f], tag); // "Info"
  const view = new DataView(frame.buffer);
  view.setUint32(tag + 4, 0x3); // flags: frame count and byte count follow
  view.setUint32(tag + 8, countFrames(audio));
  view.setUint32(tag + 12, audio.length + frame.length);
  return frame;
}
