/* Numerical layout invariants for the shipped UI circle packing function.
 * No browser, network, or packages required: node tests/verify_layout.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const context = { console };
context.window = context;
vm.createContext(context);
const ui = path.resolve(__dirname, '../ui');
vm.runInContext(fs.readFileSync(path.join(ui, 'vendor/d3-hierarchy.min.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(ui, 'bubble-layout.js'), 'utf8'), context);
const layout = context.StorageAtlasBubbleLayout;
const checks = [];
function check(name, condition, detail) {
  const row = { name, passed: !!condition };
  if (detail !== undefined) row.detail = detail;
  checks.push(row);
  process.stdout.write(`${condition ? 'PASS' : 'FAIL'} ${name}\n`);
  if (!condition && detail !== undefined) process.stdout.write(JSON.stringify(detail) + '\n');
}
function items(weights) { return weights.map((size, i) => ({ path: `item-${i}`, name: `Item ${i}`, size })); }
function verify(weights, width, height, circular = false, label = '') {
  const source = items(weights);
  const original = JSON.stringify(source);
  const circles = layout(source, width, height, { circular });
  const positive = source.filter(i => Number.isFinite(i.size) && i.size > 0);
  const scope = `${label} ${width}×${height}${circular ? ' circular' : ''}`;
  check(`${scope}: every positive item represented once`, circles.length === positive.length
    && new Set(circles.map(c => c.path)).size === positive.length);
  check(`${scope}: input left unchanged`, JSON.stringify(source) === original);
  const epsilon = Math.max(width, height) * 1e-7;
  const finite = circles.every(c => ['cx', 'cy', 'radius', 'area', 'x', 'y', 'width', 'height']
    .every(k => Number.isFinite(c[k])) && c.radius > 0 && c.area > 0);
  check(`${scope}: all circles have finite positive geometry`, finite);
  const scale = circles.length ? circles[0].area / circles[0].size : 0;
  let maxRatioError = 0;
  for (const circle of circles) {
    const ratio = circle.area / circle.size;
    maxRatioError = Math.max(maxRatioError, Math.abs(ratio - scale) / scale);
  }
  check(`${scope}: circle area is proportional to bytes`, maxRatioError < 1e-11, { maxRelativeError: maxRatioError });
  let overlap = 0;
  let minimumGap = Infinity;
  let minimumRelativeGap = Infinity;
  for (let i = 0; i < circles.length; i++) {
    for (let j = i + 1; j < circles.length; j++) {
      const a = circles[i], b = circles[j];
      const distance = Math.hypot(a.cx - b.cx, a.cy - b.cy);
      const gap = distance - a.radius - b.radius;
      overlap = Math.max(overlap, -gap);
      minimumGap = Math.min(minimumGap, gap);
      minimumRelativeGap = Math.min(minimumRelativeGap, gap / (a.radius + b.radius));
    }
  }
  check(`${scope}: sibling circles do not overlap`, overlap <= epsilon, { maxOverlapPixels: overlap });
  if(circles.length > 1) check(`${scope}: siblings retain strictly positive gaps`, minimumGap > 0,
    { minimumGapPixels: minimumGap, minimumRelativeGap });
  check(`${scope}: circles stay within viewport`, circles.every(c => c.x >= -epsilon && c.y >= -epsilon
    && c.x + c.width <= width + epsilon && c.y + c.height <= height + epsilon));
  if (circular) check(`${scope}: circles fit parent enclosure`, circles.every(c =>
    Math.hypot(c.cx - width / 2, c.cy - height / 2) + c.radius <= Math.min(width, height) / 2 + epsilon));
  check(`${scope}: repeated layout deterministic`, JSON.stringify(circles) === JSON.stringify(layout(source, width, height, { circular })));
}
check('layout exported', typeof layout === 'function');
check('empty siblings produce no geometry', layout([], 1000, 800).length === 0);
check('invalid viewport produces no geometry', layout(items([1, 2]), 0, 800).length === 0
  && layout(items([1, 2]), 1000, -2).length === 0);
check('zero negative and nonfinite weights omitted', layout(items([0, -1, NaN, Infinity, 1]), 1000, 800).length === 1);
verify([1], 1000, 800, false, 'single');
verify([1, 2, 4, 8], 1200, 800, false, 'simple ratios');
verify([1e15, 1, 2, 1e10, 1e6], 1600, 400, false, 'extreme byte ratios');
verify([1, 7, 29, 73, 223, 887, 1103], 320, 900, false, 'portrait');
verify(Array.from({ length: 128 }, (_, i) => ((i * 7919 + 17) % 10000) + 1), 1279, 721, false, 'many siblings');
verify([1, 2, 4, 8], 800, 800, true, 'parent preview');
verify([1e12, 1, 2, 1e9], 1200, 400, true, 'wide parent preview');
verify([1, 2, 4, 8], 1, 1, false, 'one pixel viewport');
const report = { passed: checks.filter(c => c.passed).length, failed: checks.filter(c => !c.passed).length, checks };
fs.writeFileSync(path.join(__dirname, 'layout-report.json'), JSON.stringify(report, null, 2));
process.stdout.write(`Result: ${report.passed} passed, ${report.failed} failed\n`);
process.exitCode = report.failed ? 1 : 0;
