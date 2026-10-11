/* Deterministic read-only API responses for camera tests. No server mutations. */
'use strict';
const path = require('path').win32;
function file(parent, name, size, category = 'Other') {
  return { path: path.join(parent, name), name, kind: 'file', size, category,
    extension: path.extname(name).toLowerCase() || '(none)', fileCount: 1, folderCount: 0, parent };
}
function folder(location, children, parent = '') {
  return { path: location, name: path.basename(location), kind: 'folder',
    size: children.reduce((s, c) => s + c.size, 0),
    fileCount: children.reduce((s, c) => s + c.fileCount, 0),
    folderCount: children.reduce((s, c) => s + c.folderCount + (c.kind === 'folder' ? 1 : 0), 0),
    parent, children: children.sort((a, b) => b.size - a.size) };
}
const archivePath = 'Z:\\QA\\Archive';
const workPath = path.join(archivePath, 'Work');
const deepPath = path.join(workPath, 'Deep');
const vaultPath = path.join(deepPath, 'Vault');
const furtherPath = path.join(vaultPath, 'Further');
const leafPath = path.join(furtherPath, 'Leaf');
const leaf = folder(leafPath, [file(leafPath, 'first.bin', 120000), file(leafPath, 'second.bin', 100000),
  file(leafPath, 'empty.txt', 0, 'Documents')], furtherPath);
const further = folder(furtherPath, [leaf, file(furtherPath, 'last.pak', 80000)], vaultPath);
const vault = folder(vaultPath, [further, file(vaultPath, 'portrait.png', 100000, 'Images')], deepPath);
const deep = folder(deepPath, [vault, file(deepPath, 'middle.pak', 200000)], workPath);
const work = folder(workPath, [deep, file(workPath, 'readme.txt', 150000, 'Documents')], archivePath);
const archive = folder(archivePath, [work, file(archivePath, 'archive.zip', 50000, 'Archives')]);
const mediaPath = 'Z:\\QA\\Media';
const media = folder(mediaPath, [file(mediaPath, 'photo.png', 120000, 'Images'),
  file(mediaPath, 'movie.mp4', 80000, 'Videos')]);
const roots = [archive, media];
function summary(node) { const { children, ...rest } = node; return rest; }
const all = [];
function walk(items) { for (const item of items) { all.push(item); if(item.children) walk(item.children); } }
walk(roots);
const nodeMap = new Map(all.map(n => [n.path.toLowerCase(), n]));
const total = roots.reduce((s, n) => s + n.size, 0);
const fileCount = roots.reduce((s, n) => s + n.fileCount, 0);
const folderCount = roots.reduce((s, n) => s + n.folderCount + 1, 0);
const status = { id: 'camera-fixture-readonly', state: 'complete', files: fileCount,
  folders: folderCount, bytes: total, currentPath: '', errors: 0,
  startedAt: '2026-10-11T01:00:00.000Z', finishedAt: '2026-10-11T01:00:00.100Z' };
const categories = new Map(), extensions = new Map();
for (const item of all.filter(n => n.kind === 'file')) {
  for (const [map, key] of [[categories, item.category], [extensions, item.extension]]) {
    const entry = map.get(key) || { name: key, size: 0, files: 0 };
    entry.size += item.size; entry.files++; map.set(key, entry);
  }
}
const overview = { id: status.id, state: status.state, roots: roots.map(summary), size: total,
  categories: [...categories.values()], extensions: [...extensions.values()], games: [], warnings: [], warningCount: 0 };
function categoryView(node,category) {
  if(!category)return node;
  if(node.kind==='file')return node.category.toLowerCase()===category.toLowerCase()?node:null;
  const children=(node.children||[]).map(n=>categoryView(n,category)).filter(n=>n&&(n.kind==='file'||n.size>0));
  return {...node,children,size:children.reduce((s,n)=>s+n.size,0),fileCount:children.reduce((s,n)=>s+n.fileCount,0),folderCount:children.reduce((s,n)=>s+n.folderCount+(n.kind==='folder'?1:0),0)};
}
function nodeResponse(query) {
  const target = query.get('path') || '';
  let node = target ? nodeMap.get(target.toLowerCase()) : {
    path: '', name: 'All scanned locations', kind: 'folder', size: total,
    fileCount, folderCount, parent: '', children: roots,
  };
  if (!node) return { code: 404, body: { error: 'Not present in camera fixture' } };
  node=categoryView(node,query.get('category')||'');
  if(!node)return {code:404,body:{error:'No category match in camera fixture'}};
  const offset = Number(query.get('offset')) || 0;
  const limit = Number(query.get('limit')) || 500;
  const children = node.children || [];
  return { code: 200, body: { ...summary(node), children: children.slice(offset, offset + limit).map(summary),
    totalChildren: children.length, childrenSizeTotal: children.reduce((s, n) => s + n.size, 0), state: 'complete' } };
}
async function install(context, record) {
  await context.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    record.push({ path: url.pathname, query: url.search, method: request.method() });
    if (!['GET', 'HEAD'].includes(request.method())) return route.abort();
    let response;
    switch(url.pathname) {
      case '/api/health': response = { app: 'StorageAtlas', port: 47831, instance: 'camera-fixture' }; break;
      case '/api/status': response = status; break;
      case '/api/drives': response = { drives: [{ path: 'Z:\\', name: 'Camera QA', total: 10000000, free: 9000000 }] }; break;
      case '/api/overview': response = overview; break;
      case '/api/node': {
        const result = nodeResponse(url.searchParams);
        return route.fulfill({ status: result.code, contentType: 'application/json', body: JSON.stringify(result.body) });
      }
      case '/api/search': {
        const q = (url.searchParams.get('q') || '').toLowerCase();
        const matches = all.filter(n => n.path.toLowerCase().includes(q)).sort((a, b) => b.size - a.size);
        response = { items: matches.slice(0, 100).map(summary), total: matches.length }; break;
      }
      case '/api/export': response = { schemaVersion: 1, scan: status, roots, categories: overview.categories }; break;
      default: return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Unknown camera fixture endpoint' }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
  });
}
module.exports = { install, roots, status, overview, nodeMap, archivePath, workPath, deepPath, vaultPath, furtherPath, leafPath };
