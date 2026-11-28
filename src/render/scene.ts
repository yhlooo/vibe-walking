import { toolMessages } from '../agent/prompts.ts';
import { gridSize } from '../level/definition.ts';
import type { Point } from '../level/definition.ts';
import type { Snapshot } from '../game/world.ts';

// 定义编辑时叠加绘制的悬停和出生位置。
type EditOverlay = { hover?: Point; spawn?: Point };

// 控制预览、截图和编辑模式下的绘制方式。
type DrawOptions = { edit?: EditOverlay; preview?: boolean; pixelHeight?: number; black?: boolean };

/** 按地图比例绘制地形、角色和可选编辑覆盖层。 */
export function drawScene(
  canvas: HTMLCanvasElement, { level, player, outcome }: Snapshot,
  { edit, preview, pixelHeight, black }: DrawOptions = {},
) {
  const { rows, columns } = gridSize(level.tiles);
  const ratio = String(columns / rows);
  if (canvas.style.getPropertyValue('--scene-ratio') !== ratio) canvas.style.setProperty('--scene-ratio', ratio);

  // 屏幕画布跟随设备像素比，截图使用固定像素高度。
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

  // 禁用实景的截图使用纯黑画布，直接跳过后续场景绘制。
  if (black) {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = '#000';
    context.fillRect(0, 0, width, height);
    return;
  }

  // 将画布缩放到网格坐标，地形与角色共用同一套绘制单位。
  context.setTransform(width / columns, 0, 0, height / rows, 0, 0);

  const background = context.createLinearGradient(0, 0, 0, rows);
  background.addColorStop(0, '#030207');
  background.addColorStop(0.5, '#100e1f');
  background.addColorStop(1, '#161227');
  context.fillStyle = background;
  context.fillRect(0, 0, columns, rows);

  if (preview) {
    context.fillStyle = '#a698e111';
    context.beginPath();
    context.moveTo(columns * 0.75, 0);
    context.lineTo(columns, 0);
    context.lineTo(columns, rows);
    context.lineTo(columns * 0.53, rows);
    context.fill();
  }

  // 仅给上方露出的实心格绘制亮边，保持地形方向一致。
  for (const [y, row] of level.tiles.entries()) {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === '#') {
        context.fillStyle = '#1a192c';
        context.fillRect(x, y, 1, 1);
        context.fillStyle = '#332f47';
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

  // 按钮固定在格子底部，通过高度表现按下状态。
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
}

// 在世界坐标系中绘制角色和朝向。
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

// 绘制编辑网格及悬停高亮。
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

/** 绘制独立画布并导出供模型读取的 PNG。 */
export function captureScene(snapshot: Snapshot, black = false): string {
  const canvas = document.createElement('canvas');
  drawScene(canvas, snapshot, { pixelHeight: 512, black });
  return canvas.toDataURL('image/png');
}
