import {
  buildPenPathD,
  layoutDirectTextBox,
  scaleMarkToViewport,
  directTextSelectionFrameFromBox,
  directTextHandleCenters,
  DIRECT_TEXT_HANDLE_RADIUS,
  estimateDirectTextBox,
} from './model.js';

const TEXT_FONT = 'system-ui, "Segoe UI", sans-serif';

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null) el.setAttribute(k, String(v));
  }
  return el;
}

function appendPenPath(svg, mark, scaled, { selected = false } = {}) {
  const path = svgEl('path', {
    class: selected ? 'mark-pen mark-selected' : 'mark-pen',
    d: buildPenPathD(scaled.points),
    fill: 'none',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  });
  const strokeW = Math.max(1, (mark.nw || 0.008) * scaled.viewportW);
  path.setAttribute('stroke-width', String(strokeW));
  const isHighlight = mark.highlight === true;
  if (isHighlight) {
    path.setAttribute('stroke', mark.color || '#FFE566');
    path.setAttribute('opacity', '0.45');
  } else {
    path.setAttribute('stroke', mark.color || '#25282D');
  }
  svg.appendChild(path);
  if (selected && scaled.points?.length) {
    let minX = scaled.points[0].x;
    let minY = scaled.points[0].y;
    let maxX = scaled.points[0].x;
    let maxY = scaled.points[0].y;
    for (const p of scaled.points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    const pad = strokeW + 6;
    svg.appendChild(svgEl('rect', {
      class: 'mark-selected-box',
      x: minX - pad,
      y: minY - pad,
      width: maxX - minX + pad * 2,
      height: maxY - minY + pad * 2,
      rx: 4,
    }));
  }
}

function appendTextMark(svg, mark, w, h, { selected = false, layoutOptions = {} } = {}) {
  const layout = layoutDirectTextBox(mark, w, h, layoutOptions);
  const g = svgEl('g', { class: 'mark-text' });
  const fontSize = layout.fontSize || layout.fontSizePx || 16;
  const lineHeight = layout.lineHeight || fontSize * 1.25;
  const baseX = layout.x;
  const baseY = layout.y + fontSize;
  for (let i = 0; i < layout.lines.length; i += 1) {
    const raw = layout.lines[i];
    const lineText = typeof raw === 'string' ? raw : raw?.text || '';
    const t = svgEl('text', {
      x: String(typeof raw === 'object' && raw?.x != null ? raw.x : baseX),
      y: String(typeof raw === 'object' && raw?.y != null ? raw.y : baseY + i * lineHeight),
      fill: mark.color || '#25282D',
      'font-size': String(fontSize),
      'font-family': TEXT_FONT,
    });
    t.textContent = lineText;
    g.appendChild(t);
  }
  svg.appendChild(g);
  if (selected) {
    const box = estimateDirectTextBox(mark, w, h, layoutOptions);
    const frame = directTextSelectionFrameFromBox(box);
    g.appendChild(svgEl('rect', {
      class: 'mark-selected-box',
      x: frame.bx,
      y: frame.by,
      width: frame.bw,
      height: frame.bh,
      rx: 4,
    }));
    const centers = directTextHandleCenters(box);
    const handles = [
      { cls: 'mark-text-handle mark-text-handle-move', cx: centers.move.x, cy: centers.move.y },
      { cls: 'mark-text-handle mark-text-handle-e', cx: centers.e.x, cy: centers.e.y },
      { cls: 'mark-text-handle mark-text-handle-w', cx: centers.w.x, cy: centers.w.y },
      { cls: 'mark-text-handle mark-text-handle-se', cx: centers.se.x, cy: centers.se.y },
    ];
    for (const handle of handles) {
      g.appendChild(svgEl('circle', {
        class: handle.cls,
        cx: handle.cx,
        cy: handle.cy,
        r: DIRECT_TEXT_HANDLE_RADIUS,
      }));
    }
  }
}

export function renderExamPdfAnnotationsSvg(
  svg,
  marks,
  w,
  h,
  { selectedId = null, hideTextId = null, layoutOptions = {} } = {},
) {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(h));
  for (const mark of marks || []) {
    if (hideTextId && mark.id === hideTextId && mark.type === 'text') continue;
    const selected = mark.id === selectedId;
    if (mark.type === 'pen') {
      const scaled = scaleMarkToViewport(mark, w, h);
      scaled.viewportW = w;
      appendPenPath(svg, mark, scaled, { selected });
    } else if (mark.type === 'text') {
      appendTextMark(svg, mark, w, h, { selected, layoutOptions });
    }
  }
}

/** Rasterize marks onto a 2D canvas (for PDF export flattening). */
export function drawExamPdfMarksOnCanvas(ctx, marks, w, h, layoutOptions = {}) {
  if (!ctx) return;
  for (const mark of marks || []) {
    if (mark.type === 'pen') {
      const scaled = scaleMarkToViewport(mark, w, h);
      const pts = scaled.points || [];
      if (pts.length < 2) continue;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const strokeW = Math.max(1, (mark.nw || 0.008) * w);
      ctx.lineWidth = strokeW;
      const isHighlight = mark.highlight === true;
      ctx.strokeStyle = mark.color || (isHighlight ? '#FFE566' : '#25282D');
      if (isHighlight) ctx.globalAlpha = 0.45;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      ctx.restore();
    } else if (mark.type === 'text') {
      const layout = layoutDirectTextBox(mark, w, h, layoutOptions);
      ctx.save();
      ctx.fillStyle = mark.color || '#25282D';
      const fontSize = layout.fontSize || layout.fontSizePx || 16;
      const lineHeight = layout.lineHeight || fontSize * 1.25;
      ctx.font = `${fontSize}px ${TEXT_FONT}`;
      ctx.textBaseline = 'alphabetic';
      const baseX = layout.x;
      const baseY = layout.y + fontSize;
      for (let i = 0; i < layout.lines.length; i += 1) {
        const raw = layout.lines[i];
        const lineText = typeof raw === 'string' ? raw : raw?.text || '';
        const x = typeof raw === 'object' && raw?.x != null ? raw.x : baseX;
        const y = typeof raw === 'object' && raw?.y != null ? raw.y : baseY + i * lineHeight;
        if (lineText) ctx.fillText(lineText, x, y);
      }
      ctx.restore();
    }
  }
}
