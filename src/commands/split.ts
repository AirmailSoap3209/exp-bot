/** Discord's message limit. */
export const MAX_MESSAGE = 2000;

/** Splits a reply into messages under Discord's limit, at line breaks (a single overlong line is cut). */
export function splitMessage(text: string, max = MAX_MESSAGE): string[] {
  const out: string[] = [];
  let cur = '';
  for (const raw of text.split('\n')) {
    for (let line = raw; ; line = line.slice(max)) {
      const piece = line.slice(0, max);
      if (cur && cur.length + 1 + piece.length > max) {
        out.push(cur);
        cur = piece;
      } else cur = cur ? `${cur}\n${piece}` : piece;
      if (line.length <= max) break;
    }
  }
  if (cur || !out.length) out.push(cur);
  return out;
}
