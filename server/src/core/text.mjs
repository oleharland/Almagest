/**
 * text.mjs — small text helpers every module shares.
 */

/**
 * Free text as one short line, for a commit message or a log row: control
 * characters, line breaks (including a lone carriage return, U+0085, U+2028
 * and U+2029) and runs of spaces become single spaces, and the length is
 * capped. A title or a name must not be able to add a line to a message that
 * carries `Approved by:` and `Reviewed head:` trailers.
 */
export function oneLine(value, max = 200) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\s]+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
