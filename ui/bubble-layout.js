(function (global) {
  'use strict';
  // A single scale is used for the whole sibling set. Never inflate a small
  // circle to make it clickable: that would misrepresent its byte count.
  function clusteredLayout(items, width, height, options) {
    const max = Math.max(...items.map(item => Number(item.size)));
    const gap = options && Number.isFinite(Number(options.gap)) ? Math.max(0, Number(options.gap)) : .115;
    const circles = items.map(item => {
      const drawRadius = Math.sqrt(Number(item.size) / max);
      if (!item._cluster) return {item, drawRadius, r: drawRadius * (1 + gap)};
      const members = (item.clusterItems || []).filter(child => Number.isFinite(Number(child.size)) && Number(child.size) > 0)
        .map(child => ({item: child, drawRadius: Math.sqrt(Number(child.size) / max), r: Math.sqrt(Number(child.size) / max) * (1 + gap)}));
      const packed = members.slice();
      // Reserve the unrequested tail without inventing files or a folder.
      if (Number(item.remainingBytes) > 0) packed.push({r: Math.sqrt(Number(item.remainingBytes) / max) * (1 + gap) * 1.28, pending: true});
      if (!packed.length) packed.push({r: drawRadius * (1 + gap), pending: true});
      global.d3.packSiblings(packed);
      const enclosure = global.d3.packEnclose(packed);
      packed.forEach(member => {member.x -= enclosure.x; member.y -= enclosure.y;});
      return {item, drawRadius, members, r: enclosure.r * 1.09,
        pending: packed.find(member => member.pending)};
    });
    // Place the quiet collection first, then reserve room for every large peer.
    circles.sort((a,b) => Number(!!b.item._cluster) - Number(!!a.item._cluster) || b.r-a.r);
    global.d3.packSiblings(circles);
    const center = circles.find(circle => circle.item._cluster);
    const angle = options && Number.isFinite(Number(options.rotation)) ? Number(options.rotation) : -.12;
    const cosine = Math.cos(angle), sine = Math.sin(angle), originX = center.x, originY = center.y;
    let reachX = 0, reachY = 0, reachCircle = 0;
    circles.forEach(circle => {
      const x = circle.x-originX, y = circle.y-originY;
      circle.x = x*cosine-y*sine; circle.y = x*sine+y*cosine;
      reachX = Math.max(reachX, Math.abs(circle.x)+circle.r);
      reachY = Math.max(reachY, Math.abs(circle.y)+circle.r);
      reachCircle = Math.max(reachCircle, Math.hypot(circle.x,circle.y)+circle.r);
    });
    const scale = options && options.circular ? Math.min(width,height)/(2*reachCircle)
      : Math.min(width/(2*reachX),height/(2*reachY));
    const entry = (item,cx,cy,radius) => ({item,path:item.path,size:item.size,x:cx-radius,y:cy-radius,width:radius*2,height:radius*2,cx,cy,radius,r:radius,area:Math.PI*radius*radius,byteScale:scale/Math.sqrt(max)});
    return circles.map(circle => {
      const cx = width/2+circle.x*scale, cy = height/2+circle.y*scale;
      const result = entry(circle.item,cx,cy,circle.drawRadius*scale);
      if (circle.members) {
        result.clusterRadius = circle.r*scale;
        result.members = circle.members.map(member => entry(member.item,cx+member.x*scale,cy+member.y*scale,member.drawRadius*scale));
        if(circle.pending) result.pending = {cx:cx+circle.pending.x*scale,cy:cy+circle.pending.y*scale,radius:circle.pending.r*scale};
      }
      return result;
    });
  }
  function layout(items, width, height, options) {
    if (!(width > 0 && height > 0)) return [];
    const positive = items.filter(item => Number.isFinite(Number(item.size)) && Number(item.size) > 0);
    if (!positive.length) return [];
    if (positive.some(item => item._cluster)) return clusteredLayout(positive,width,height,options);
    const max = Math.max(...positive.map(item => Number(item.size)));
    // Pack larger collision envelopes, then draw the true byte radii. This
    // leaves breathing room without exaggerating any item's relative size.
    const gap = options && Number.isFinite(Number(options.gap))
      ? Math.max(0, Number(options.gap)) : 0.115;
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
