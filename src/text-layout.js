// Width here means code points, which is right for the ASCII and box-drawing text hyperfocus draws.
export const widthOf = (text) => [...text].length;

export function truncate(text, width) {
  if (widthOf(text) <= width) return text;
  return [...text].slice(0, Math.max(0, width - 1)).join('') + '…';
}

// Word-wraps `text` into lines of at most `width`, breaking words that are longer than a line.
export function wrap(text, width) {
  const safeWidth = Math.max(1, width);
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    for (const piece of chunk(word, safeWidth)) {
      if (!line) line = piece;
      else if (widthOf(line) + 1 + widthOf(piece) <= safeWidth) line += ` ${piece}`;
      else {
        lines.push(line);
        line = piece;
      }
    }
  }
  if (line) lines.push(line);
  return lines;
}

function chunk(word, width) {
  const characters = [...word];
  const pieces = [];
  for (let index = 0; index < characters.length; index += width) pieces.push(characters.slice(index, index + width).join(''));
  return pieces;
}
