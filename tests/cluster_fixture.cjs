/* Generic, deterministic siblings. No native service or personal paths. */
'use strict';
const path=require('path').win32;
const rootPath='Q:\\Virtual Collection';
function file(parent,name,size,category='Other'){
  return {path:path.join(parent,name),parent,name,size,category,kind:'file',extension:path.extname(name)||'(none)',fileCount:1,folderCount:0};
}
function folder(location,children,parent=''){
  return {path:location,parent,name:path.basename(location),kind:'folder',children,
    size:children.reduce((n,c)=>n+c.size,0),fileCount:children.reduce((n,c)=>n+c.fileCount,0),
    folderCount:children.reduce((n,c)=>n+c.folderCount+(c.kind==='folder'?1:0),0)};
}
function siblings(count,distribution='balanced'){
  const output=[];
  for(let i=0;i<count;i++){
    const size=distribution==='mixed'?(i<3?[80000000,36000000,12000000][i]:1200+(i%17)*83):1000000+(i%13)*73000;
    output.push(file(rootPath,`Virtual item ${String(i+1).padStart(4,'0')}.bin`,size));
  }
  return output.sort((a,b)=>b.size-a.size||a.path.localeCompare(b.path));
}
const smallFolderPath=path.join(rootPath,'Small folder');
const root=folder(rootPath,[file(rootPath,'Large archive.bin',80000000),file(rootPath,'Large media.bin',36000000),
  folder(smallFolderPath,[file(smallFolderPath,'Tiny readme.txt',3500,'Documents'),file(smallFolderPath,'Tiny asset.bin',2100)],rootPath),
  ...siblings(317,'mixed').slice(3).map((item,index)=>({...item,name:`Small sibling ${String(index+1).padStart(4,'0')}.bin`,path:path.join(rootPath,`Small sibling ${String(index+1).padStart(4,'0')}.bin`)})),
  file(rootPath,'Zero bytes.txt',0,'Documents')]);
const summaries=items=>items.map(({children,...item})=>item);
const all=[];(function walk(items){for(const item of items){all.push(item);if(item.children)walk(item.children);}})([root]);
const nodeMap=new Map(all.map(item=>[item.path.toLowerCase(),item]));
const status={id:'virtual-cluster-fixture',revision:0,state:'complete',files:root.fileCount,folders:root.folderCount+1,bytes:root.size,currentPath:'',errors:0};
const overview={...status,size:root.size,roots:summaries([root]),categories:[{name:'Other',size:root.size,files:root.fileCount}],games:[],gameLibraries:[],extensions:[],warnings:[],warningCount:0};
function api(url){
  if(url.pathname==='/api/status')return status;
  if(url.pathname==='/api/overview')return overview;
  if(url.pathname==='/api/drives')return{drives:[{path:'Q:\\',name:'Virtual drive',total:1000000000,free:1000000000-root.size}]};
  if(url.pathname==='/api/health')return{app:'StorageAtlas',product:'File Gazer'};
  if(url.pathname==='/api/node'){
    const requested=url.searchParams.get('path')||'';
    const node=requested?nodeMap.get(requested.toLowerCase()):folder('',[root]);
    if(!node)return{error:'Unknown virtual item'};
    const children=(node.children||[]).slice().sort((a,b)=>b.size-a.size||a.path.localeCompare(b.path));
    const offset=Number(url.searchParams.get('offset'))||0,limit=Number(url.searchParams.get('limit'))||500;
    return {...summaries([node])[0],children:summaries(children.slice(offset,offset+limit)),totalChildren:children.length,
      childrenSizeTotal:children.reduce((n,c)=>n+c.size,0),remainingSize:children.slice(offset).reduce((n,c)=>n+c.size,0),offset,limit,state:'complete',revision:0};
  }
  if(url.pathname==='/api/search')return{items:[],total:0};
  return{error:'Unsupported virtual endpoint'};
}
const origin='http://file-gazer-cluster.test';
async function install(context,requests,override){
  const fs=require('fs'),nativePath=require('path'),ui=nativePath.resolve(__dirname,'../ui');
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    requests.push({method:request.method(),origin:url.origin,path:url.pathname,query:url.search});
    if(url.origin!==origin)return route.abort();
    if(override&&await override(route,url,request))return;
    if(!['GET','HEAD'].includes(request.method()))return route.abort();
    if(url.pathname.startsWith('/api/')){const body=api(url);return route.fulfill({status:body.error?404:200,contentType:'application/json',body:JSON.stringify(body)});}
    const location=nativePath.resolve(ui,'.'+(url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname)));
    if(!location.startsWith(ui+nativePath.sep)||!fs.existsSync(location))return route.fulfill({status:404,body:'No virtual asset'});
    return route.fulfill({contentType:{'.html':'text/html','.css':'text/css','.js':'application/javascript','.svg':'image/svg+xml','.ico':'image/x-icon'}[nativePath.extname(location)]||'application/octet-stream',body:fs.readFileSync(location)});
  });
}
module.exports={rootPath,root,smallFolderPath,siblings,summaries,all,nodeMap,status,overview,api,origin,install};
