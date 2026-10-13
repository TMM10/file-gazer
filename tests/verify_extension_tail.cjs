/* Global extension paging: exact same-layer clusters, entirely virtual requests. */
'use strict';
const fs=require('fs'),path=require('path'),fixture=require('./cluster_fixture.cjs');
const args=process.argv.slice(2),arg=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
const pw=require(arg('--playwright-module','playwright')),checks=[],requests=[],searches=[],errors=[];
const files=Array.from({length:300},(_,i)=>({path:fixture.rootPath+'\\bulk-'+String(i).padStart(3,'0')+'.bulk',name:'bulk-'+String(i).padStart(3,'0')+'.bulk',kind:'file',size:1299-i,parent:fixture.rootPath,category:'Other',extension:'.bulk',fileCount:1,folderCount:0}));
const sum=items=>items.reduce((n,item)=>n+item.size,0),total=sum(files),fileMap=new Map(files.map(file=>[file.path,file]));
const root={path:fixture.rootPath,parent:'',name:'Virtual Collection',kind:'folder',size:total,fileCount:files.length,folderCount:0};
const status={...fixture.status,files:files.length,folders:1,bytes:total};
const overview={...fixture.overview,...status,size:total,roots:[root],categories:[{name:'Other',size:total,files:files.length}],extensions:[{name:'.bulk',size:total,files:files.length}]};
function check(name,ok,detail){checks.push({name,passed:!!ok,...(detail===undefined?{}:{detail})});process.stdout.write(`${ok?'PASS':'FAIL'} ${name}\n`);if(!ok&&detail)process.stdout.write(JSON.stringify(detail)+'\n');}
const state=page=>page.evaluate(()=>window.StorageAtlasCameraTest.getState());
const crumbs=page=>page.locator('#breadcrumbs button').allTextContents();
const formatted=bytes=>bytes===0?'0 B':bytes<1024?bytes+' B':Math.round(bytes/1024)+' KB';
function clusterBytes(snapshot,cluster){return snapshot.nodes.filter(node=>cluster.memberIds.includes(node.id)).reduce((n,node)=>n+node.size,0)+cluster.remainingBytes;}
function sameRoute(a,b){return JSON.stringify(a)===JSON.stringify(b);}
async function run(){
  const browser=await pw.chromium.launch({headless:true,...(arg('--chrome')?{executablePath:arg('--chrome')}:{})});
  const context=await browser.newContext({viewport:{width:1440,height:1050}});
  await fixture.install(context,requests,async(route,url,request)=>{
    if(!['GET','HEAD'].includes(request.method()))return false;
    let body;
    if(url.pathname==='/api/overview')body=overview;
    else if(url.pathname==='/api/status')body=status;
    else if(url.pathname==='/api/drives')body={drives:[{path:'Q:\\',name:'Virtual drive',total:1000000,free:1000000-total}]};
    else if(url.pathname==='/api/search'&&url.searchParams.get('extension')==='.bulk'){
      const offset=Number(url.searchParams.get('offset'))||0,limit=Number(url.searchParams.get('limit'))||100;
      searches.push({offset,limit,path:url.searchParams.get('path')||'',category:url.searchParams.get('category')||'',query:url.searchParams.get('q')||''});
      body={items:files.slice(offset,offset+limit),total:files.length,offset,limit,state:'complete',revision:0};
    }else if(url.pathname==='/api/node'){
      const requested=url.searchParams.get('path')||'',offset=Number(url.searchParams.get('offset'))||0,limit=Number(url.searchParams.get('limit'))||500;
      if(requested&&requested!==fixture.rootPath){await route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({error:'Unknown virtual folder'})});return true;}
      const children=requested?files:[root];
      body={...(requested?root:{path:'',parent:'',name:'All scanned locations',kind:'folder',size:total,fileCount:files.length,folderCount:1}),children:children.slice(offset,offset+limit),totalChildren:children.length,childrenSizeTotal:total,remainingSize:sum(children.slice(offset)),offset,limit,state:'complete',revision:0};
    }
    if(body){await route.fulfill({contentType:'application/json',body:JSON.stringify(body)});return true;}return false;
  });
  const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
  try{
    await page.goto(fixture.origin);await page.locator('.list-row[data-path]').waitFor();
    await page.locator('.nav-item[data-mode="types"]').click();
    await page.locator('.list-row').filter({has:page.locator('.row-title',{hasText:/^\.bulk$/})}).click();
    await page.waitForFunction(()=>{const s=window.StorageAtlasCameraTest?.getState();return s?.route.extension==='.bulk'&&s.clusters?.some(c=>c.memberIds.length>0&&c.remainingBytes>0);});
    await page.waitForFunction(()=>document.querySelector('.list-row .row-title')?.textContent==='bulk-000.bulk');
    const initial=await state(page),cluster=initial.clusters.find(c=>c.memberIds.length>0&&c.remainingBytes>0),routeBefore=initial.route,breadcrumbsBefore=await crumbs(page),sceneBefore=initial.sceneKey;
    const initialMembers=initial.nodes.filter(node=>cluster.memberIds.includes(node.id));
    const siblingFiles=initial.nodes.filter(node=>node.parentId===cluster.parentId&&node.kind==='file');
    const kept=siblingFiles.filter(node=>!cluster.memberIds.includes(node.id)),keptBytes=sum(kept);
    check('global extension header uses all 300 files before expansion',await page.locator('#item-count').textContent()==='300'&&await page.locator('#total-size').textContent()===formatted(total),{total,text:await page.locator('#total-size').textContent()});
    check('initial extension cluster has exact complete omitted bytes',cluster.size===total-keptBytes&&clusterBytes(initial,cluster)===cluster.size,{size:cluster.size,remaining:cluster.remainingBytes,known:initialMembers.length,expected:total-keptBytes});
    check('initial extension page accounts for 100 real files and the 200-file remainder',siblingFiles.length===100&&cluster.remainingBytes===sum(files.slice(100)),{siblings:siblingFiles.length,remaining:cluster.remainingBytes});
    check('extension cluster members use genuine same-layer file identities',initialMembers.every(node=>fileMap.has(node.path)&&node.parentId===cluster.parentId)&&new Set(initialMembers.map(node=>node.depth)).size===1);
    check('extension route has no artificial Other offset or breadcrumb',routeBefore.mode==='types'&&routeBefore.extension==='.bulk'&&!routeBefore.path&&!routeBefore.query&&!routeBefore.otherStart&&!routeBefore.groupOffset&&breadcrumbsBefore.join('|')==='File types|.bulk',{route:routeBefore,breadcrumbs:breadcrumbsBefore});
    await page.evaluate(()=>window.__extensionSvg=document.querySelector('.bubble-camera-svg'));
    const stage=await page.locator('#map-stage').boundingBox();
    await page.mouse.click(stage.x+cluster.screenCx,stage.y+cluster.screenCy,{button:'right'});
    await page.locator('#context-menu').waitFor({state:'visible'});
    await page.locator('#context-menu [data-action="explore"]').click();
    await page.waitForFunction(id=>window.StorageAtlasCameraTest.getState().clusters.find(c=>c.id===id)?.active,cluster.id);
    const active=await state(page);
    check('exploring extension cluster keeps route, breadcrumb and original scene',sameRoute(active.route,routeBefore)&&active.sceneKey===sceneBefore&&JSON.stringify(await crumbs(page))===JSON.stringify(breadcrumbsBefore));
    check('exploring extension cluster retains SVG and adds no artificial aggregate node',await page.evaluate(()=>window.__extensionSvg===document.querySelector('.bubble-camera-svg'))&&active.nodes.every(node=>node.kind!=='aggregate'));
    let previous=active;
    for(let index=0;index<2;index++){
      const beforeCluster=previous.clusters.find(c=>c.id===cluster.id),beforeIds=new Set(beforeCluster.memberIds),requestStart=searches.length,offset=100+index*100;
      await page.locator('.camera-cluster-more').filter({visible:true}).first().click();
      await page.waitForFunction(({id,count})=>window.StorageAtlasCameraTest.getState().clusters.find(c=>c.id===id)?.memberIds.length===count+100,{id:cluster.id,count:beforeIds.size});
      const loaded=await state(page),current=loaded.clusters.find(c=>c.id===cluster.id),members=loaded.nodes.filter(node=>current.memberIds.includes(node.id)),added=members.filter(node=>!beforeIds.has(node.id)),newRequests=searches.slice(requestStart);
      check(`extension Load more page ${index+1} fetches exactly the next 100 files`,newRequests.length===1&&newRequests[0].offset===offset&&newRequests[0].limit===100&&newRequests[0].path===''&&newRequests[0].category===''&&newRequests[0].query==='',newRequests);
      check(`extension Load more page ${index+1} preserves exact aggregate and global bytes`,current.size===cluster.size&&clusterBytes(loaded,current)===cluster.size&&current.remainingBytes===sum(files.slice(offset+100))&&sum(loaded.nodes.filter(node=>node.parentId===current.parentId&&node.kind==='file'))+current.remainingBytes===total,{cluster:current.size,known:sum(members),remaining:current.remainingBytes,total});
      check(`extension Load more page ${index+1} preserves same-layer identities without duplicates`,added.length===100&&added.every(node=>files.slice(offset,offset+100).some(file=>file.path===node.path))&&members.every(node=>node.parentId===cluster.parentId&&node.depth===initialMembers[0].depth)&&new Set(members.map(node=>node.path)).size===members.length&&loaded.nodes.every(node=>node.kind!=='aggregate'));
      check(`extension Load more page ${index+1} retains route and breadcrumbs`,sameRoute(loaded.route,routeBefore)&&loaded.sceneKey===sceneBefore&&JSON.stringify(await crumbs(page))===JSON.stringify(breadcrumbsBefore)&&await page.locator('#total-size').textContent()===formatted(total));
      previous=loaded;
    }
    const complete=previous.clusters.find(c=>c.id===cluster.id);
    check('two explicit pages expose all 300 extension files with no remaining bytes',complete.remainingBytes===0&&previous.nodes.filter(node=>node.parentId===complete.parentId&&node.kind==='file').length===300);
    check('exhausted extension cluster hides its Load more control',await page.locator('.camera-cluster-more').filter({visible:true}).count()===0);
    const seen=[];
    for(let index=0;index<3;index++){
      await page.waitForFunction(name=>document.querySelector('.list-row .row-title')?.textContent===name,files[index*100].name);
      seen.push(...await page.locator('.list-row[data-path]').evaluateAll(rows=>rows.map(row=>row.dataset.path)));
      check(`ordinary extension list page ${index+1} contains its full 100-row range`,await page.locator('.list-row[data-path]').count()===100&&(await page.locator('#page-range').textContent())===`${index*100+1}–${(index+1)*100} of 300`);
      if(index<2)await page.locator('#next-page').click();
    }
    check('ordinary extension list pagination covers 300 unique files and exact bytes',seen.length===300&&new Set(seen).size===300&&seen.reduce((n,p)=>n+(fileMap.get(p)?.size||0),0)===total,{rows:seen.length,unique:new Set(seen).size,total});
    check('last extension list page disables Next and retains the extension breadcrumb',await page.locator('#next-page').isDisabled()&&JSON.stringify(await crumbs(page))===JSON.stringify(breadcrumbsBefore));
    for(let index=1;index>=0;index--){await page.locator('#previous-page').click();await page.waitForFunction(name=>document.querySelector('.list-row .row-title')?.textContent===name,files[index*100].name);}
    check('returning to page zero restores the full global extension byte header',await page.locator('#total-size').textContent()===formatted(total)&&await page.locator('#item-count').textContent()==='300'&&await page.locator('#previous-page').isDisabled()&&sameRoute((await state(page)).route,routeBefore));
    await page.screenshot({path:path.join(__dirname,'extension-tail.png')});
  }catch(error){check('global extension cluster scenario completes',false,{message:error.message,stack:error.stack});await page.screenshot({path:path.join(__dirname,'extension-tail-failure.png')});}
  finally{
    check('extension suite sends only virtual same-origin read requests',requests.every(request=>request.origin===fixture.origin&&['GET','HEAD'].includes(request.method)),requests.filter(request=>request.origin!==fixture.origin||!['GET','HEAD'].includes(request.method)));
    check('extension suite has no uncaught JavaScript errors',errors.length===0,errors);
    await context.close();await browser.close();
    const report={passed:checks.filter(check=>check.passed).length,failed:checks.filter(check=>!check.passed).length,virtualOnly:true,totalFiles:files.length,totalBytes:total,checks,searches};
    fs.writeFileSync(path.join(__dirname,'extension-tail-report.json'),JSON.stringify(report,null,2));process.stdout.write(`Result: ${report.passed} passed, ${report.failed} failed\n`);process.exitCode=report.failed?1:0;
  }
}
run().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
