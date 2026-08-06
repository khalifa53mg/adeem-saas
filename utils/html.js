// Helpers for the PDF routes, which assemble HTML as template literals rather than
// going through EJS — so anything user-typed has to be escaped by hand.

/** Escape a value for interpolation into HTML text or a double-quoted attribute. */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { esc };
