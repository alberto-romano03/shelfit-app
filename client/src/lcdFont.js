// The 14-segment LCD font (DSEG14 Modern, SIL OFL: client/public/font, its
// licence beside it), shared by the deck's displays: the Now Playing screen in
// the header and the Stopped at counter. Fetched once, when the first of them is
// shown (a 6 KB file), from the app itself (the Content-Security-Policy allows
// fonts from 'self' only) and under the app's path.
import { withBase } from './basePath.js';

export const LCD_FONT = 'DSEG14 Modern';
const LCD_FONT_URL = '/font/DSEG14Modern-Regular.woff2';
// The font's "every segment" glyph: a cell's unlit segments, drawn faintly behind.
export const LCD_ALL_SEGMENTS = '~';
// Its blank cell, as wide as a digit.
export const LCD_BLANK = '!';

let asked = false;
export function loadLcdFont() {
  if (asked || typeof FontFace !== 'function') return;
  asked = true;
  const face = new FontFace(LCD_FONT, `url("${withBase(LCD_FONT_URL)}") format('woff2')`);
  face
    .load()
    .then(() => document.fonts.add(face))
    .catch(() => {
      asked = false; // try again next time
    });
}
