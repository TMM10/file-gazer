(function (global) {
  'use strict';
  // A single scale is used for the whole sibling set. Never inflate a small
  // circle to make it clickable: that would misrepresent its byte count.
  function layout(items, width, height, options) {
    if (!(width > 0 && height > 0)) return [];
    const positive = items.filter(item => Number.isFinite(Number(item.size)) && Number(item.size) > 0);
    if (!positive.length) return [];
    const max = Math.max(...positive.map(item => Number(item.size)));
    // Pack larger collision envelopes, then draw the true byte radii. This
    // leaves breathing room without exaggerating any item's relative size.
    const gap = options && Number.isFinite(Number(options.gap))
      ? Math.max(0, Number(options.gap)) : 0.085;
    const circles = positive.map(item => {
      const drawRadius = Math.sqrt(Number(item.size) / max);
      return { item, drawRadius, r: drawRadius * (1 + gap) };
    });
    circles.sort((a, b) => b.r - a.r || String(a.item.path || a.item.name || '').localeCompare(String(b.item.path || b.item.name || '')));
    global.d3.packSiblings(circles);
    // A slight shared tilt keeps the constellation from forming a rigid row.
    // Rotation preserves every pairwise distance and the reserved gaps.
    const angle = options && Number.isFinite(Number(options.rotation))
      ? Number(options.rotation) : -0.12;
    const cosine = Math.cos(angle), sine = Math.sin(angle);
    circles.forEach(c => {
      const x = c.x * cosine - c.y * sine;
      c.y = c.x * sine + c.y * cosine;
      c.x = x;
    });
    const enclosing = global.d3.packEnclose(circles);
    // Fit to the rectangular viewport rather than an arbitrary enclosing
    // circle, so wide displays use their width when the packing allows it.
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    circles.forEach(c => {
      left = Math.min(left, c.x - c.r); right = Math.max(right, c.x + c.r);
      top = Math.min(top, c.y - c.r); bottom = Math.max(bottom, c.y + c.r);
    });
    const inCircle = options && options.circular;
    const scale = inCircle ? Math.min(width, height) / (2 * enclosing.r)
      : Math.min(width / (right - left), height / (bottom - top));
    const dx = inCircle ? width / 2 - enclosing.x * scale
      : (width - (right - left) * scale) / 2 - left * scale;
    const dy = inCircle ? height / 2 - enclosing.y * scale
      : (height - (bottom - top) * scale) / 2 - top * scale;
    return circles.map(c => {
      const radius = c.drawRadius * scale;
      const cx = c.x * scale + dx, cy = c.y * scale + dy;
      return { item: c.item, path: c.item.path, size: c.item.size,
        x: cx - radius, y: cy - radius, width: radius * 2, height: radius * 2,
        cx, cy, radius, r: radius, area: Math.PI * radius * radius };
    });
  }
  global.StorageAtlasBubbleLayout = layout;
})(window);
