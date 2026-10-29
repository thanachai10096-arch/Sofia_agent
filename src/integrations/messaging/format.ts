/** Split text without losing characters; conservative default fits common chat limits. */
export function splitMessage(text: string, maxCharacters: number): string[] {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 32 || maxCharacters > 100_000) {
    throw new Error("maxCharacters must be between 32 and 100000.");
  }
  if (!text) return [""];
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(offset + maxCharacters, text.length);
    // Count limits are measured in UTF-16 code units by JavaScript. Never leave
    // half of a surrogate pair at the end of one message and its mate in another.
    if (end < text.length) {
      const last = text.charCodeAt(end - 1);
      const next = text.charCodeAt(end);
      if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
    }
    chunks.push(text.slice(offset, end));
    offset = end;
  }
  return chunks;
}
