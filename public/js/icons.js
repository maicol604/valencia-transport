// 24×24 stroke pictograms shared by the canvas stop layer and the HTML UI.
export const GLYPHS = {
  bus: 'M8 3h8a3 3 0 0 1 3 3v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a3 3 0 0 1 3-3zM5 11h14M8 18v2.5M16 18v2.5M8.5 14.5h.01M15.5 14.5h.01M2.5 7.5v3M21.5 7.5v3',
  metro: 'M5.5 18V7.5l6.5 7 6.5-7V18',
  train: 'M6 5c0-1.2 3-2 6-2s6 .8 6 2v10a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2zM6 10h12M12 3.5V10M9 13.5h.01M15 13.5h.01M8.5 21l2-4M15.5 21l-2-4',
  bike: 'M2.5 16a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0M14.5 16a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0M6 16l3.5-6.5h6L18 16M9.5 9.5L12 16H6M15.5 9.5l-1.2-3H12.5',
};

const paths = new Map();
export const glyphPath = name => {
  if (!paths.has(name)) paths.set(name, new Path2D(GLYPHS[name] || GLYPHS.bus));
  return paths.get(name);
};

export const glyphSVG = (name, className = 'glyph') =>
  `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${GLYPHS[name] || GLYPHS.bus}"/></svg>`;
