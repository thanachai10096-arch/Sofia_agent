/** Split text without losing characters; conservative default fits common chat limits. */
export function splitMessage(text: string, maxCharacters: number): string[] {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 32 || maxCharacters > 100_000) {
    throw new Error("maxCharacters must be between 32 and 100000.");
  }
  if (!text) return [""];
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += maxCharacters) {
    chunks.push(text.slice(offset, offset + maxCharacters));
  }
  return chunks;
}
