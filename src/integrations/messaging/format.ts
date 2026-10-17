/** Split text without losing characters; conservative default fits common chat limits. */
export function splitMessage(text: string, maxCharacters: number): string[] {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 32 || maxCharacters > 100_000) {
    throw new Error("maxCharacters must be between 32 and 100000.");
  }
  if (!text) return [""];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxCharacters) {
    let cut = remaining.lastIndexOf("\n", maxCharacters);
    if (cut < Math.floor(maxCharacters * 0.5)) cut = remaining.lastIndexOf(" ", maxCharacters);
    if (cut < Math.floor(maxCharacters * 0.5)) cut = maxCharacters;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
    if (remaining.startsWith("\n") || remaining.startsWith(" ")) remaining = remaining.slice(1);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
