/* Virtual file tree: exact singleton and dominant-child chains, no real files. */
'use strict';
const fs=require('fs'),path=require('path'),win=path.win32;
const uiRoot=path.resolve(__dirname,'../ui');
const origin='http://file-gazer-labels.test';
function file(parent,name,size,category='Other'){
  return {path:win.join(parent,name),parent,name,kind:'file',size,category,extension:win.extname(name)||'(none)',fileCount:1,folderCount:0};
}
function folder(location,children,parent=''){
  return {path:location,parent,name:win.basename(location),kind:'folder',children:children.sort((a,b)=>b.size-a.size),size:children.reduce((n,c)=>n+c.size,0),fileCount:children.reduce((n,c)=>n+c.fileCount,0),folderCount:children.reduce((n,c)=>n+c.folderCount+(c.kind==='folder'?1:0),0)};
}
const singletonNames=['Library','Games','Steam','steamapps','common','A Very Long Game Installation Name','Content','Assets'];
const singletonPaths=singletonNames.reduce((out,name)=>[...out,win.join(out.at(-1)||'Q:\\Label QA',name)],[]);
let chain=folder(singletonPaths.at(-1),[
  file(singletonPaths.at(-1),'World Geometry.pak',350000,'Games'),
  file(singletonPaths.at(-1),'Character Textures.png',210000,'Images'),
  file(singletonPaths.at(-1),'Installation Guide.pdf',140000,'Documents')
],singletonPaths.at(-2));
for(let i=singletonPaths.length-2;i>=0;i--)chain=folder(singletonPaths[i],[chain],singletonPaths[i-1]||'');
const dominantNames=['Mixed Library','Primary Folder','Almost All Bytes','Another Dominant Folder','Nested Content','Mixed Leaves'];
const dominantPaths=dominantNames.reduce((out,name)=>[...out,win.join(out.at(-1)||'Q:\\Label QA',name)],[]);
let mixed=folder(dominantPaths.at(-1),[
  file(dominantPaths.at(-1),'Holiday Recording.mp4',165000,'Videos'),
  file(dominantPaths.at(-1),'Large Photo Collection.jpg',100000,'Images'),
  file(dominantPaths.at(-1),'Readable Notes.txt',20000,'Documents')
],dominantPaths.at(-2));
for(let i=dominantPaths.length-2;i>=0;i--)mixed=folder(dominantPaths[i],[mixed,file(dominantPaths[i],'Small Sibling '+(i+1)+'.txt',3000,'Documents')],dominantPaths[i-1]||'');
const documentsPath='Q:\\Label QA\\Documents';
const documents=folder(documentsPath,[file(documentsPath,'Budget.xlsx',60000,'Documents'),file(documentsPath,'Presentation.pdf',40000,'Documents')]);
const programPath='Q:\\Label QA\\Program Files',libraryPath=win.join(programPath,'Steam Games Library'),toolsPath=win.join(programPath,'Tools');
const commonPath=win.join(libraryPath,'Common Games'),supportPath=win.join(libraryPath,'Support Packages');
const firstGamePath=win.join(commonPath,'Game One'),secondGamePath=win.join(commonPath,'Game Two'),contentPath=win.join(firstGamePath,'Content');
const content=folder(contentPath,[file(contentPath,'Worlds.pak',240000,'Games'),file(contentPath,'Textures.pak',160000,'Games')],firstGamePath);
const gameOne=folder(firstGamePath,[content,file(firstGamePath,'Readme.txt',50000,'Documents')],commonPath);
const gameTwo=folder(secondGamePath,[file(secondGamePath,'Maps.pak',200000,'Games'),file(secondGamePath,'Textures.png',150000,'Images')],commonPath);
const common=folder(commonPath,[gameOne,gameTwo],libraryPath);
const enginePath=win.join(supportPath,'Engine'),redistPath=win.join(supportPath,'Redistributables');
const engine=folder(enginePath,[file(enginePath,'Engine.dll',350000,'Applications')],supportPath);
const redist=folder(redistPath,[file(redistPath,'Runtime.dll',250000,'Applications')],supportPath);
const support=folder(supportPath,[engine,redist],libraryPath);
const library=folder(libraryPath,[common,support],programPath);
const tools=folder(toolsPath,[file(toolsPath,'Utility.exe',100000,'Applications'),file(toolsPath,'Manual.pdf',100000,'Documents')],programPath);
const program=folder(programPath,[library,tools]);
const roots=[chain,mixed,documents,program],all=[];
(function walk(nodes){for(const node of nodes){all.push(node);if(node.children)walk(node.children);}})(roots);
const nodeMap=new Map(all.map(node=>[node.path.toLowerCase(),node]));
const summary=node=>{const {children,...rest}=node;return rest;};
const total=roots.reduce((n,c)=>n+c.size,0),fileCount=roots.reduce((n,c)=>n+c.fileCount,0),folderCount=roots.reduce((n,c)=>n+c.folderCount+1,0);
const status={id:'singleton-label-fixture',state:'complete',files:fileCount,folders:folderCount,bytes:total,currentPath:'',errors:0,startedAt:'2026-10-11T01:00:00Z',finishedAt:'2026-10-11T01:00:01Z'};
const categories=new Map(),extensions=new Map();
for(const item of all.filter(n=>n.kind==='file'))for(const [map,key] of [[categories,item.category],[extensions,item.extension]]){const entry=map.get(key)||{name:key,size:0,files:0};entry.size+=item.size;entry.files++;map.set(key,entry);}
const overview={id:status.id,state:'complete',roots:roots.map(summary),size:total,categories:[...categories.values()],extensions:[...extensions.values()],games:[],warnings:[],warningCount:0};
function categoryView(node,category){if(!category)return node;if(node.kind==='file')return node.category.toLowerCase()===category.toLowerCase()?node:null;const children=(node.children||[]).map(c=>categoryView(c,category)).filter(c=>c&&c.size>0);return {...node,children,size:children.reduce((n,c)=>n+c.size,0),fileCount:children.reduce((n,c)=>n+c.fileCount,0),folderCount:children.reduce((n,c)=>n+c.folderCount+(c.kind==='folder'?1:0),0)};}
function api(url){
  switch(url.pathname){
    case '/api/health':return {app:'StorageAtlas',product:'File Gazer',port:47831,instance:'singleton-label-fixture'};
    case '/api/status':return status;
    case '/api/drives':return {drives:[{path:'Q:\\',name:'Virtual label test',total:10000000,free:10000000-total}]};
    case '/api/overview':return overview;
    case '/api/node':{
      const target=url.searchParams.get('path')||'';
      let node=target?nodeMap.get(target.toLowerCase()):{path:'',name:'All scanned locations',kind:'folder',size:total,fileCount,folderCount,parent:'',children:roots};
      if(!node)return {error:'Unknown virtual folder'};
      node=categoryView(node,url.searchParams.get('category')||'');if(!node)return {error:'Unknown virtual category'};
      const children=node.children||[],offset=Number(url.searchParams.get('offset'))||0,limit=Number(url.searchParams.get('limit'))||500;
      return {...summary(node),children:children.slice(offset,offset+limit).map(summary),totalChildren:children.length,childrenSizeTotal:children.reduce((n,c)=>n+c.size,0),state:'complete'};
    }
    case '/api/search':{const q=(url.searchParams.get('q')||'').toLowerCase(),items=all.filter(n=>n.path.toLowerCase().includes(q)).sort((a,b)=>b.size-a.size);return {items:items.slice(0,100).map(summary),total:items.length};}
    default:return {error:'Unknown virtual endpoint'};
  }
}
async function install(context,requests){
  // Intercept every request, including static assets. No live service is contacted.
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());requests.push({method:request.method(),path:url.pathname});
    if(url.origin!==origin||!['GET','HEAD'].includes(request.method()))return route.abort();
    if(url.pathname.startsWith('/api/')){const body=api(url);return route.fulfill({status:body.error?404:200,contentType:'application/json',body:JSON.stringify(body)});}
    const location=path.resolve(uiRoot,'.'+(url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname)));
    if(!location.startsWith(uiRoot+path.sep)||!fs.existsSync(location))return route.fulfill({status:404,body:'No virtual asset'});
    const contentType={'.html':'text/html','.css':'text/css','.js':'application/javascript','.svg':'image/svg+xml'}[path.extname(location)]||'application/octet-stream';
    return route.fulfill({status:200,contentType,body:fs.readFileSync(location)});
  });
}
module.exports={install,origin,roots,nodeMap,status,overview,singletonNames,singletonPaths,dominantNames,dominantPaths,documentsPath,programPath,libraryPath,toolsPath,commonPath,supportPath,firstGamePath};
