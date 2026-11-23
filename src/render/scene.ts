import { toolMessages } from '../agent/prompts.ts';
import { gridSize } from '../level/definition.ts';
import type { Point } from '../level/definition.ts';
import type { Snapshot } from '../game/world.ts';

type EditOverlay = { hover?: Point; spawn?: Point };
type DrawOptions = { edit?: EditOverlay; preview?: boolean; pixelHeight?: number };

export function drawScene(
  canvas: HTMLCanvasElement, { level, player, outcome }: Snapshot,
  { edit, preview, pixelHeight }: DrawOptions = {},
) {
  const { rows, columns } = gridSize(level.tiles);
  const ratio = String(columns / rows);
  if (canvas.style.getPropertyValue('--scene-ratio') !== ratio) canvas.style.setProperty('--scene-ratio', ratio);
  if (pixelHeight === undefined) {
    const size = canvas.getBoundingClientRect();
    if (size.width === 0 || size.height === 0) return;
    const scale = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(size.width * scale));
    const height = Math.max(1, Math.round(size.height * scale));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
  } else {
    canvas.width = Math.round(pixelHeight * columns / rows);
    canvas.height = pixelHeight;
  }
  const context = canvas.getContext('2d');
  if (!context) throw new Error(toolMessages.cannotDrawScreen);
  const { width, height } = canvas;
  context.setTransform(width / columns, 0, 0, height / rows, 0, 0);

  const background = context.createLinearGradient(0, 0, 0, rows);
  background.addColorStop(0, '#24213e');
  background.addColorStop(1, '#423b6c');
  context.fillStyle = background;
  context.fillRect(0, 0, columns, rows);

  if (preview) {
    context.fillStyle = '#a698e108';
    context.beginPath();
    context.moveTo(0, 0);
    context.lineTo(columns * 0.25, 0);
    context.lineTo(columns * 0.5, rows);
    context.lineTo(0, rows);
    context.fill();
    context.fillStyle = '#a698e10c';
    context.beginPath();
    context.moveTo(columns * 0.75, 0);
    context.lineTo(columns, 0);
    context.lineTo(columns, rows);
    context.lineTo(columns * 0.53, rows);
    context.fill();
  }

  for (const [y, row] of level.tiles.entries()) {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === '#') {
        context.fillStyle = '#1a192c';
        context.fillRect(x, y, 1, 1);
        context.fillStyle = '#29263e';
        context.fillRect(x + 0.025, y + 0.025, 0.95, 0.95);
        if (level.tiles[y - 1]?.[x] !== '#') {
          context.fillStyle = '#72639c';
          context.fillRect(x, y, 1, 0.06);
        }
      }
    }
  }

  if (edit?.spawn) {
    const { x, y } = edit.spawn;
    context.strokeStyle = '#c2a9ff';
    context.lineWidth = 0.05;
    context.strokeRect(x + 0.025, y + 0.025, 0.95, 0.95);
  }
  drawCharacter(context, player, player.facing);
  for (const [y, row] of level.tiles.entries()) {
    const x = row.indexOf('B');
    if (x < 0) continue;
    const pressed = outcome === 'won';
    const protrusion = pressed ? 0.06 : 0.15;
    const top = y + 1 - protrusion;
    context.fillStyle = pressed ? '#ff536d' : '#f03559';
    context.fillRect(x, top, 1, protrusion);
    context.fillStyle = '#ffa3af';
    context.fillRect(x + 0.08, top, 0.84, 0.025);
  }

  if (edit) drawGrid(context, columns, rows, edit.hover);
  context.fillStyle = '#1a192c';
  context.fillRect(0, 0, columns, rows * 0.009);
  context.fillStyle = '#72639c';
  context.fillRect(0, rows * 0.009, columns, rows * 0.003);
}

function drawCharacter(context: CanvasRenderingContext2D, { x, y }: Point, facing: -1 | 1) {
  context.fillStyle = '#f8f3f1';
  context.beginPath();
  context.roundRect(x, y, 1, 1, 0.02);
  context.fill();
  const eye = x + (facing > 0 ? 0.49 : 0.29);
  context.fillStyle = '#27233e';
  context.fillRect(eye, y + 0.30, 0.085, 0.20);
  context.fillRect(eye + 0.18, y + 0.30, 0.085, 0.20);
}

function drawGrid(context: CanvasRenderingContext2D, columns: number, rows: number, hover?: Point) {
  context.beginPath();
  context.strokeStyle = '#beb0ff29';
  context.lineWidth = 0.015;
  for (let x = 1; x < columns; x++) {
    context.moveTo(x, 0);
    context.lineTo(x, rows);
  }
  for (let y = 1; y < rows; y++) {
    context.moveTo(0, y);
    context.lineTo(columns, y);
  }
  context.stroke();
  if (hover) {
    context.fillStyle = '#d7c4ff2b';
    context.fillRect(hover.x, hover.y, 1, 1);
    context.strokeStyle = '#d7c4ff';
    context.lineWidth = 0.025;
    context.strokeRect(hover.x + 0.0125, hover.y + 0.0125, 0.975, 0.975);
  }
}

export function captureScene(snapshot: Snapshot): string {
  const canvas = document.createElement('canvas');
  drawScene(canvas, snapshot, { pixelHeight: 512 });
  return canvas.toDataURL('image/png');
}
