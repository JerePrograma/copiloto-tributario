export function chunkText(text: string, size = 700, overlap = 120) {
  const clean = text.replace(/\r/g, "");
  const chunks: { content: string; start: number; end: number; idx: number }[] =
    [];
  let i = 0,
    idx = 0;
  while (i < clean.length) {
    const end = Math.min(i + size, clean.length);
    const slice = clean.slice(i, end);
    chunks.push({ content: slice, start: i, end, idx });
    if (end === clean.length) break;
    i = end - overlap;
    if (i < 0) i = 0;
    idx++;
  }
  return chunks;
}
