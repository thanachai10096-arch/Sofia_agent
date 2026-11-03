export interface VoiceAudioChunk {
  /** Zero-based, strictly increasing sequence number within one stream. */
  sequence: number;
  /** A single bounded audio payload. The consumer must not mutate it. */
  bytes: Uint8Array;
  /** True only for the final chunk, when the transport provides this signal. */
  final?: boolean;
}

export interface VoiceAudioStreamLimits {
  maxChunkBytes?: number;
  maxTotalBytes?: number;
  maxChunks?: number;
}

const DEFAULT_MAX_CHUNK_BYTES = 256 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_CHUNKS = 4096;

function boundedInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(name + " must be an integer between 1 and " + maximum);
  }
  return value;
}

/**
 * Validates and copies an untrusted inbound audio stream incrementally.
 * It does not concatenate or persist chunks, so memory use is bounded by the
 * configured per-chunk limit plus the upstream transport's own buffering.
 *
 * The source should also honor the supplied AbortSignal while waiting for data.
 */
export async function* iterateBoundedVoiceAudio(
  source: AsyncIterable<VoiceAudioChunk>,
  limits: VoiceAudioStreamLimits = {},
  signal?: AbortSignal,
): AsyncGenerator<VoiceAudioChunk> {
  const maxChunkBytes = boundedInteger(limits.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES, "maxChunkBytes", 4 * 1024 * 1024);
  const maxTotalBytes = boundedInteger(limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES, "maxTotalBytes", 100 * 1024 * 1024);
  const maxChunks = boundedInteger(limits.maxChunks ?? DEFAULT_MAX_CHUNKS, "maxChunks", 100_000);
  let expectedSequence = 0;
  let totalBytes = 0;
  let sawFinal = false;

  for await (const chunk of source) {
    signal?.throwIfAborted();
    if (sawFinal) throw new Error("Voice audio stream received data after final chunk");
    if (!chunk || typeof chunk !== "object" || !Number.isSafeInteger(chunk.sequence) ||
        chunk.sequence !== expectedSequence) {
      throw new Error("Voice audio stream chunk sequence is invalid");
    }
    if (!(chunk.bytes instanceof Uint8Array) || chunk.bytes.byteLength === 0) {
      throw new Error("Voice audio stream chunk must contain non-empty bytes");
    }
    if (chunk.bytes.byteLength > maxChunkBytes) throw new Error("Voice audio stream chunk exceeds configured byte limit");
    if (expectedSequence >= maxChunks) throw new Error("Voice audio stream exceeds configured chunk count");
    totalBytes += chunk.bytes.byteLength;
    if (totalBytes > maxTotalBytes) throw new Error("Voice audio stream exceeds configured total byte limit");

    const final = chunk.final === true;
    if (chunk.final !== undefined && typeof chunk.final !== "boolean") {
      throw new Error("Voice audio stream final marker must be boolean");
    }
    sawFinal = final;
    expectedSequence++;
    yield { sequence: chunk.sequence, bytes: chunk.bytes.slice(), ...(final ? { final: true } : {}) };
  }

  signal?.throwIfAborted();
  if (expectedSequence === 0) throw new Error("Voice audio stream is empty");
}
