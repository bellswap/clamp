// The share card (STYLE-SPEC component 9): 1200 by 630 PNG drawn on a canvas, dark always, in Archivo (call
// loadShareFont first). Left 60 percent: monogram,
// symbol, side and multiple, entry and print, the move; right 40 percent: the payout as the hero and the stake under
// it; a perforation at 520 px; the footer with the glyph, the wordmark, "Take the other side" with the link, and the
// one disclaimer line.
import { COPY, PRODUCT_NAME } from '../copy';
import { fmtPct, fmtPrice, fmtUsd } from './format';
import { horizonName } from './horizon';
import { movePct } from './payout';
import type { TicketView } from './types';
import { monoLetters } from '../components/Monogram';

// The dark palette of tokens.css (bellswap.fun's): square corners, Archivo.
const C = { bg: '#000000', surface: '#0C0E0A', surface2: '#151810', border: '#23261F', text: '#F4F5F0', muted: '#8E948A', faint: '#5E6459', up: '#CCFF00', down: '#FF6A3D', upSoft: 'rgba(204,255,0,0.14)', downSoft: 'rgba(255,106,61,0.14)', accent: '#CCFF00' };
const SANS = '"Archivo", "Helvetica Neue", Arial, sans-serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

/** Loads Archivo before the canvas draws with it; a failed load falls back to the stack's next face. */
export async function loadShareFont(): Promise<void> {
  try {
    await document.fonts.load('600 32px Archivo');
  } catch {
    // the fallback face draws the card
  }
}

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.beginPath();
  ctx.rect(x, y, w, h);
}

// The split wick mark (ui.tsx Glyph), 64-unit grid: two stepped halves and the wick.
const MARK_HALVES = 'M24 12H16V28H12V40H4V48H24ZM40 12H48V28H52V40H60V48H40Z';
const MARK_WICK = 'M28 4H36V60H28Z';

function glyph(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  const k = s / 64;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k, k);
  ctx.fillStyle = C.text;
  ctx.fill(new Path2D(MARK_HALVES));
  ctx.fillStyle = C.accent;
  ctx.fill(new Path2D(MARK_WICK));
  ctx.restore();
}

export function drawShareCard(canvas: HTMLCanvasElement, t: TicketView, link: string): void {
  canvas.width = 1200;
  canvas.height = 630;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const payout = t.payout ?? 0;
  const won = payout > t.stake;
  const tone = won ? C.up : C.down;
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, 1200, 630);
  ctx.textBaseline = 'alphabetic';

  // left: monogram, symbol, side and multiple
  rr(ctx, 72, 72, 96, 96);
  ctx.fillStyle = C.surface2;
  ctx.fill();
  ctx.fillStyle = C.muted;
  ctx.font = `600 38px ${SANS}`;
  ctx.textAlign = 'center';
  ctx.fillText(monoLetters(t.symbol), 120, 134);
  ctx.textAlign = 'left';
  ctx.fillStyle = C.text;
  ctx.font = `600 64px ${SANS}`;
  ctx.fillText(t.symbol, 196, 132);
  const side = t.long ? COPY.ticket.long : COPY.ticket.short;
  ctx.font = `600 24px ${SANS}`;
  const sw = ctx.measureText(side).width + 36;
  rr(ctx, 72, 204, sw, 44);
  ctx.fillStyle = t.long ? C.upSoft : C.downSoft;
  ctx.fill();
  ctx.fillStyle = t.long ? C.up : C.down;
  ctx.fillText(side, 90, 234);
  ctx.fillStyle = C.text;
  ctx.font = `500 28px ${SANS}`;
  ctx.fillText([`${t.leverage}x`, horizonName(t.horizon), PRODUCT_NAME].filter(Boolean).join('  ·  '), 72 + sw + 20, 236);

  // entry, print, move
  const settle = t.settlePrice ?? t.entryPrice;
  ctx.font = `500 30px ${SANS}`;
  ctx.fillStyle = C.muted;
  ctx.fillText(COPY.watch.entry, 72, 328);
  ctx.fillText(COPY.watch.print, 72, 384);
  ctx.fillText(COPY.watch.move, 72, 440);
  ctx.fillStyle = C.text;
  ctx.fillText(fmtPrice(t.entryPrice), 200, 328);
  ctx.fillStyle = C.accent;
  ctx.font = `700 30px ${SANS}`;
  ctx.fillText(fmtPrice(settle), 200, 384);
  ctx.font = `500 30px ${SANS}`;
  const mv = movePct(t.entryPrice, settle);
  ctx.fillStyle = mv < 0 ? C.down : C.up;
  ctx.fillText(fmtPct(mv), 200, 440);

  // right: payout hero
  ctx.textAlign = 'right';
  ctx.fillStyle = C.muted;
  ctx.font = `500 26px ${SANS}`;
  ctx.fillText(COPY.watch.payout, 1128, 230);
  ctx.fillStyle = tone;
  ctx.font = `700 120px ${SANS}`;
  ctx.fillText(fmtUsd(payout), 1128, 350);
  ctx.fillStyle = C.muted;
  ctx.font = `500 28px ${SANS}`;
  ctx.fillText(`USDG on ${fmtUsd(t.stake)} staked`, 1128, 400);
  ctx.textAlign = 'left';

  // accent ring
  ctx.strokeStyle = C.accent;
  ctx.lineWidth = 2;
  rr(ctx, 24, 24, 1152, 582);
  ctx.stroke();

  // perforation
  ctx.strokeStyle = C.faint;
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 8]);
  ctx.beginPath();
  ctx.moveTo(24, 506);
  ctx.lineTo(1176, 506);
  ctx.stroke();
  ctx.setLineDash([]);

  // footer
  glyph(ctx, 72, 534, 32);
  ctx.fillStyle = C.text;
  ctx.font = `600 30px ${SANS}`;
  ctx.fillText(COPY.brand, 116, 560);
  ctx.textAlign = 'right';
  ctx.font = `500 22px ${MONO}`;
  ctx.fillStyle = C.text;
  ctx.fillText(`${COPY.watch.takeOther} → ${link.replace(/^https?:\/\//, '')}`, 1128, 556);
  ctx.font = `400 18px ${SANS}`;
  ctx.fillStyle = C.muted;
  ctx.fillText(COPY.shareLine, 1128, 584);
  ctx.textAlign = 'left';
}

export function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('no blob'))), 'image/png'));
}
