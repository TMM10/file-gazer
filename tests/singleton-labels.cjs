/* Folder-name continuity in concentric chains. Every request is virtual. */
'use strict';
const fs=require('fs'),path=require('path'),fixture=require('./singleton_fixture.cjs');
const args=process.argv.slice(2),arg=(key,fallback)=>args.includes(key)?args[args.indexOf(key)+1]:fallback;
const pw=require(arg('--playwright-module','playwright')),checks=[],recordings=[],requests=[],errors=[];
// The selectors are the public DOM contract agreed with the camera owner.
const TRAIL='.camera-folder-trail',ROW='.camera-trail-row[data-path]';
function check(name,ok,detail){checks.push({name,passed:!!ok,...(detail===undefined?{}:{detail})});process.stdout.write(`${ok?'PASS':'FAIL'} ${name}\n`);if(!ok&&detail!==undefined)process.stdout.write(JSON.stringify(detail)+'\n');}
const state=page=>page.evaluate(()=>window.StorageAtlasCameraTest.getState());
async function settled(page){await page.waitForFunction(()=>{const c=window.StorageAtlasCameraTest.getState().camera;return Number.isFinite(c.scale)&&Math.abs(c.scale/c.targetScale-1)<1e-4;});}
async function listClick(page,location){await page.locator('.list-row').filter({has:page.locator('.row-title',{hasText:new RegExp('^'+fixture.nodeMap.get(location.toLowerCase()).name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')})}).click();}
async function record(page,label){await page.evaluate(({label,TRAIL,ROW})=>{
  window.__qaSingletonRecording={label,running:true,frames:[]};
  function sample(t){
    const box=window.__qaSingletonRecording;if(!box.running)return;
    const s=window.StorageAtlasCameraTest.getState(),stage=document.querySelector('#map-stage').getBoundingClientRect(),trail=document.querySelector(TRAIL);
    const shown=el=>!!el&&getComputedStyle(el).display!=='none'&&getComputedStyle(el).visibility!=='hidden'&&Number(getComputedStyle(el).opacity)>.25&&el.getBoundingClientRect().width>0;
    const rect=b=>({left:b.left,top:b.top,right:b.right,bottom:b.bottom,width:b.width,height:b.height});
    const rows=trail?[...trail.querySelectorAll(ROW)].map(row=>({path:row.dataset.path,name:row.querySelector('.camera-trail-name')?.textContent.trim()||row.textContent.trim(),bounds:rect(row.getBoundingClientRect()),clientWidth:row.clientWidth,scrollWidth:row.scrollWidth})):[];
    const texts=[];
    for(const label of document.querySelectorAll('.bubble-label')){
      if(!shown(label)||Number(label.getAttribute('opacity'))<.5)continue;
      for(const text of label.querySelectorAll('text')){
        if(!text.textContent.trim()||!shown(text)||Number(getComputedStyle(text).opacity)<.5)continue;
        const b=text.getBoundingClientRect();if(b.right<=stage.left||b.left>=stage.right||b.bottom<=stage.top||b.top>=stage.bottom)continue;
        texts.push({owner:label.dataset.nodeId,text:text.textContent,type:'spatial',...rect(b)});
      }
    }
    if(shown(trail))for(const row of trail.querySelectorAll(ROW)){
      const label=row.querySelector('.camera-trail-name')||row,range=document.createRange();range.selectNodeContents(label);
      const clip=trail.querySelector('.camera-trail-rows').getBoundingClientRect();for(const b of range.getClientRects()){
        const left=Math.max(stage.left,clip.left,b.left),right=Math.min(stage.right,clip.right,b.right),top=Math.max(stage.top,clip.top,b.top),bottom=Math.min(stage.bottom,clip.bottom,b.bottom);
        if(right>left&&bottom>top)texts.push({owner:row.dataset.path,text:row.textContent.trim(),type:'trail',left,right,top,bottom});
      }
    }
    box.frames.push({t,frame:s.frame,camera:s.camera,route:s.route,sceneKey:s.sceneKey,...(label.includes('semantic')?{detailAnchor:s.detailAnchor,nodes:s.nodes.map(n=>({id:n.id,path:n.path,parentPath:n.parentPath,opacity:n.opacity,visible:n.visible,interactive:n.interactive,labelVisible:n.labelVisible,radius:n.radius}))}:{}),trail:{visible:shown(trail),rows,bounds:trail?rect(trail.getBoundingClientRect()):null,clientHeight:trail?.clientHeight,scrollHeight:trail?.scrollHeight},texts});
    if(box.frames.length<1000)requestAnimationFrame(sample);
  }
  requestAnimationFrame(sample);
},{label,TRAIL,ROW});}
async function finish(page){const result=await page.evaluate(()=>{window.__qaSingletonRecording.running=false;return window.__qaSingletonRecording;});recordings.push(result);return result.frames;}
function namesFrom(frame,chain){return frame.trail.rows.filter(row=>chain.includes(row.path)).map(row=>row.path);}
function continuity(frames,chain,names,label,{minDepth=8,monotone=false,rootMayRetire=false}={}){
  const active=frames.filter(f=>f.trail.visible),badPrefixes=[],dropped=[],missingNames=[];let deepest=0,previous=[];
  for(const f of active){const paths=namesFrom(f,chain);deepest=Math.max(deepest,paths.length);if(paths.some((p,i)=>p!==chain[i]))badPrefixes.push({frame:f.frame,paths});
    if(monotone&&previous.some((p,i)=>paths[i]!==p))dropped.push({frame:f.frame,previous,paths});
    for(const row of f.trail.rows){const i=chain.indexOf(row.path);if(i>=0&&!row.name.includes(names[i]))missingNames.push({frame:f.frame,path:row.path,text:row.name,expected:names[i]});}
    if(paths.length)previous=paths;
  }
  const identified=frames.filter(f=>f.trail.visible||(rootMayRetire&&f.texts.some(t=>t.type==='spatial'&&t.text.includes(names[0]))));
  check(label+': folder identity stays readable in every sampled frame',identified.length===frames.length&&frames.length>=12,{frames:frames.length,visible:active.length,identified:identified.length});
  check(label+': chain path is always ordered and complete to its endpoint',badPrefixes.length===0,badPrefixes.slice(0,3));
  check(label+': folder names remain in readable trail text',missingNames.length===0,missingNames.slice(0,3));
  check(label+': exploration reaches at least '+minDepth+' named folders',deepest>=minDepth,{deepest});
  if(monotone)check(label+': zooming deeper never drops an ancestor name',dropped.length===0,dropped.slice(0,3));
  return {deepest};
}
function noOverlap(frames,label,allowSingle=false){let comparisons=0,overlaps=0;const examples=[];
  for(const f of frames)for(let i=0;i<f.texts.length;i++)for(let j=i+1;j<f.texts.length;j++){
    const a=f.texts[i],b=f.texts[j];if(a.owner===b.owner)continue;comparisons++;
    const w=Math.min(a.right,b.right)-Math.max(a.left,b.left),h=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top);
    if(w>1&&h>1){overlaps++;if(examples.length<3)examples.push({frame:f.frame,a:a.text,b:b.text,types:[a.type,b.type],w,h});}
  }
  check(label+': actual readable text boxes do not overlap',(comparisons>0||allowSingle)&&overlaps===0,{comparisons,overlaps,examples});
}
async function gesture(page,label,deltas,pause=900,followPaths=null){
  const center=await page.evaluate(()=>{const r=document.querySelector('#map-stage').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};});
  await page.mouse.move(center.x,center.y);await record(page,label);for(const dy of deltas){
    if(followPaths){const next=await page.evaluate(paths=>{const s=window.StorageAtlasCameraTest.getState(),stage=document.querySelector('#map-stage').getBoundingClientRect(),node=s.nodes.filter(n=>paths.includes(n.path)&&n.interactive).sort((a,b)=>b.depth-a.depth)[0];if(!node)return null;
      // Follow the shifted child using real pointer motion, preserving cursor zoom.
      for(const [dx,dy] of [[0,.2],[.3,.3],[-.3,.3],[.5,0],[0,.5]]){const x=Math.max(6,Math.min(stage.width-6,node.screenCx+node.radius*dx)),y=Math.max(6,Math.min(stage.height-6,node.screenCy+node.radius*dy)),target=document.elementFromPoint(stage.left+x,stage.top+y);if(!target?.closest('.camera-folder-trail,.camera-controls'))return{x:stage.left+x,y:stage.top+y};}return null;
    },followPaths);if(next)await page.mouse.move(next.x,next.y);}
    await page.mouse.wheel(0,dy);await page.waitForTimeout(70);
  }await page.waitForTimeout(pause);return finish(page);
}
async function paused(page,label){await settled(page);await record(page,label);await page.waitForTimeout(850);const frames=await finish(page),identities=new Set(frames.map(f=>namesFrom(f,fixture.singletonPaths).join('|')));check(label+': paused folder path stays stable',identities.size===1&&frames.every(f=>f.trail.visible),{identities:[...identities]});return frames;}
function trailRow(page,name){return page.locator(TRAIL+' '+ROW).filter({has:page.locator('.camera-trail-name',{hasText:new RegExp('^'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')})}).first();}
async function trailInteractions(page,label){
  await page.evaluate(()=>window.scrollTo(0,0));const before=await state(page),pageY=await page.evaluate(()=>scrollY);
  const scrollBox=await page.locator('.camera-trail-rows').boundingBox();await page.mouse.move(scrollBox.x+scrollBox.width/2,scrollBox.y+scrollBox.height/2);await page.mouse.wheel(0,-1200);await page.waitForTimeout(100);
  const top=await page.evaluate(()=>{const rows=document.querySelector('.camera-trail-rows'),first=rows.querySelector('.camera-trail-row'),b=first.getBoundingClientRect(),clip=rows.getBoundingClientRect();return{top:rows.scrollTop,overflow:rows.scrollHeight>rows.clientHeight,path:document.elementFromPoint(b.left+b.width/2,Math.max(clip.top,b.top)+Math.min(b.height,clip.height)/2)?.closest('.camera-trail-row')?.dataset.path};});
  check(label+': trail wheel reaches the earlier root row',top.overflow&&top.top===0&&top.path===fixture.singletonPaths[0],top);
  await page.mouse.wheel(0,1200);await page.waitForTimeout(100);const bottom=await page.evaluate(()=>{const rows=document.querySelector('.camera-trail-rows'),last=rows.querySelector('.camera-trail-row:last-child'),b=last.getBoundingClientRect();return{bottom:rows.scrollTop+rows.clientHeight>=rows.scrollHeight-1,path:document.elementFromPoint(b.left+b.width/2,b.top+b.height/2)?.closest('.camera-trail-row')?.dataset.path};}),after=await state(page);
  check(label+': trail wheel reaches deepest row without zoom or page scroll',bottom.bottom&&bottom.path===fixture.singletonPaths.at(-1)&&after.camera.targetScale===before.camera.targetScale&&await page.evaluate(()=>scrollY)===pageY,{bottom,beforeScale:before.camera.targetScale,afterScale:after.camera.targetScale,pageY,afterPageY:await page.evaluate(()=>scrollY)});
  const long=trailRow(page,fixture.singletonNames[5]);await long.scrollIntoViewIfNeeded();const wrapped=await long.locator('.camera-trail-name').evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);return{text:el.textContent,lines:range.getClientRects().length,clientWidth:el.clientWidth,scrollWidth:el.scrollWidth,whiteSpace:getComputedStyle(el).whiteSpace};});
  check(label+': long name is complete and fits available width',wrapped.text===fixture.singletonNames[5]&&wrapped.scrollWidth<=wrapped.clientWidth+1&&wrapped.whiteSpace!=='nowrap',wrapped);
  if(label==='compact')check(label+': long name actually wraps into readable lines',wrapped.lines>=2,wrapped);
  const chainPaths=(await state(page)).folderTrail.paths;
  await page.locator('#fullscreen-button').click();await page.waitForFunction(()=>document.body.classList.contains('is-immersive'));await page.waitForTimeout(550);
  const immersive=await page.evaluate(()=>{const stage=document.querySelector('#map-stage').getBoundingClientRect(),trail=document.querySelector('.camera-folder-trail').getBoundingClientRect(),toolbar=document.querySelector('#immersive-toolbar').getBoundingClientRect();return{paths:window.StorageAtlasCameraTest.getState().folderTrail.paths,visible:!document.querySelector('.camera-folder-trail').hidden,trail:{x:trail.x,y:trail.y,right:trail.right,bottom:trail.bottom},stage:{x:stage.x,y:stage.y,right:stage.right,bottom:stage.bottom},toolbarBottom:toolbar.bottom,native:!!document.fullscreenElement};});
  check(label+': fullscreen retains established folder trail identity',immersive.visible&&JSON.stringify(immersive.paths)===JSON.stringify(chainPaths),immersive);
  check(label+': fullscreen trail is below toolbar and inside map',immersive.trail.y>=immersive.toolbarBottom&&immersive.trail.x>=immersive.stage.x&&immersive.trail.right<=immersive.stage.right&&immersive.trail.bottom<=immersive.stage.bottom,immersive);
  check(label+': requested fullscreen mode is used',label==='compact'?!immersive.native:immersive.native,{native:immersive.native});
  await page.waitForFunction(()=>document.querySelector('#toast').hidden);
  await page.screenshot({path:path.join(__dirname,'singleton-labels-'+label+'-fullscreen.png')});
  await page.locator('#immersive-exit').click();await page.waitForFunction(()=>!document.body.classList.contains('is-immersive'));await page.waitForTimeout(300);
  check(label+': leaving fullscreen preserves established trail',JSON.stringify((await state(page)).folderTrail.paths)===JSON.stringify(chainPaths));
  await long.scrollIntoViewIfNeeded();await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(__dirname,'singleton-labels-'+label+'.png')});
  const ancestor=trailRow(page,'Steam');await ancestor.scrollIntoViewIfNeeded();const oldFocus=await state(page);await ancestor.click({modifiers:['Shift']});await page.waitForFunction(p=>window.StorageAtlasCameraTest.getState().nodes.some(n=>n.path===p&&n.selected),fixture.singletonPaths[2]);const selected=await state(page);
  check(label+': Shift trail click selects exact folder without focus or zoom',selected.nodes.some(n=>n.path===fixture.singletonPaths[2]&&n.selected)&&selected.camera.focusPath===oldFocus.camera.focusPath&&selected.camera.targetScale===oldFocus.camera.targetScale,{selected:selected.nodes.filter(n=>n.selected).map(n=>n.path),focus:selected.camera.focusPath});
  await page.locator('#clear-selected').click();await page.evaluate(()=>window.scrollTo(0,0));await ancestor.scrollIntoViewIfNeeded();const methodCount=requests.filter(r=>!['GET','HEAD'].includes(r.method)).length;await ancestor.click({button:'right'});await page.waitForFunction(()=>!document.querySelector('#context-menu').hidden);
  const menu=await page.locator('.context-menu-title').evaluate(el=>({text:el.textContent,path:el.title}));check(label+': right-click trail menu identifies exact row folder',menu.text==='Steam'&&menu.path===fixture.singletonPaths[2],menu);await page.keyboard.press('Escape');
  check(label+': cancelling trail menu sends no native request',await page.locator('#context-menu').evaluate(el=>el.hidden)&&requests.filter(r=>!['GET','HEAD'].includes(r.method)).length===methodCount);
  await page.locator('#clear-selected').click();await page.evaluate(()=>window.scrollTo(0,0));
}
async function semanticHierarchy(page,label){
  await page.locator('.camera-controls [aria-label="Fit all bubbles"]').click();await settled(page);await page.waitForFunction(()=>!window.StorageAtlasCameraTest.getState().route.path);await listClick(page,fixture.programPath);await settled(page);await page.waitForTimeout(500);await page.evaluate(()=>window.scrollTo(0,0));
  const before=await state(page),immediate=before.nodes.filter(n=>n.parentPath===fixture.programPath),large=immediate.find(n=>n.path===fixture.libraryPath),deeper=before.nodes.filter(n=>n.path.startsWith(fixture.programPath+'\\')&&n.parentPath!==fixture.programPath);
  check(label+': explicit Program Files focus anchors its hierarchy level',before.detailAnchor?.path===fixture.programPath&&before.camera.focusPath===fixture.programPath,before.detailAnchor);
  check(label+': clicked folder exposes immediate contents and readable largest name',immediate.length===2&&immediate.every(n=>n.visible&&n.interactive)&&large?.labelVisible,{immediate:immediate.map(n=>({name:n.name,visible:n.visible,interactive:n.interactive,labelVisible:n.labelVisible}))});
  check(label+': clicked folder does not peer into grandchildren at rest',deeper.every(n=>!n.visible&&!n.interactive&&n.opacity<.025),{loadedDeeper:deeper.length,visibleDeeper:deeper.filter(n=>n.visible||n.interactive).map(n=>n.path)});
  await page.locator('#fullscreen-button').click();await page.waitForFunction(()=>document.body.classList.contains('is-immersive'));await page.waitForTimeout(550);const fullLevel=await state(page),fullChildren=fullLevel.nodes.filter(n=>n.parentPath===fixture.programPath),fullDeeper=fullLevel.nodes.filter(n=>n.path.startsWith(fixture.programPath+'\\')&&n.parentPath!==fixture.programPath);
  check(label+': fullscreen resize preserves explicit immediate-level visibility',fullLevel.detailAnchor?.path===fixture.programPath&&fullLevel.sceneKey===before.sceneKey&&fullChildren.length===2&&fullChildren.every(n=>n.visible&&n.interactive)&&fullChildren.find(n=>n.path===fixture.libraryPath)?.labelVisible&&fullDeeper.every(n=>!n.visible&&!n.interactive),{anchor:fullLevel.detailAnchor,children:fullChildren.map(n=>({name:n.name,visible:n.visible,labelVisible:n.labelVisible})),visibleDeeper:fullDeeper.filter(n=>n.visible||n.interactive).map(n=>n.path)});
  await page.locator('#immersive-exit').click();await page.waitForFunction(()=>!document.body.classList.contains('is-immersive'));await page.waitForTimeout(350);const returned=await state(page);
  check(label+': fullscreen exit preserves the same explicit hierarchy anchor and children',returned.detailAnchor?.path===fixture.programPath&&returned.nodes.filter(n=>n.parentPath===fixture.programPath).every(n=>n.visible&&n.interactive)&&returned.nodes.find(n=>n.path===fixture.libraryPath)?.labelVisible);
  const small=await gesture(page,label+' semantic small wheel',[-65],650),still=await state(page),allImmediateVisible=small.every(f=>f.nodes.some(n=>n.path===fixture.libraryPath&&n.visible&&n.labelVisible));
  check(label+': small continuous zoom never blanks immediate folder identity',allImmediateVisible,{frames:small.length,blankFrames:small.filter(f=>!f.nodes.some(n=>n.path===fixture.libraryPath&&n.visible&&n.labelVisible)).length});
  check(label+': small zoom keeps grandchildren hidden',still.nodes.filter(n=>n.path.startsWith(fixture.programPath+'\\')&&n.parentPath!==fixture.programPath).every(n=>!n.visible&&!n.interactive));noOverlap(small,label+' semantic small zoom',true);
  const largeFrames=await gesture(page,label+' semantic gradual deeper wheel',Array(5).fill(-80)),zoomed=await state(page),grandchildren=zoomed.nodes.filter(n=>n.parentPath===fixture.libraryPath),intermediateReveal=largeFrames.filter(f=>f.nodes.some(n=>n.path===fixture.commonPath&&n.opacity>.025&&n.opacity<.95));
  check(label+': further wheel progressively reveals next folder level',grandchildren.length===2&&grandchildren.every(n=>n.visible&&n.interactive)&&intermediateReveal.length>=3,{grandchildren:grandchildren.map(n=>({name:n.name,opacity:n.opacity,visible:n.visible,interactive:n.interactive})),intermediateFrames:intermediateReveal.length});
  check(label+': automatic context focus never promotes explicit detail anchor',zoomed.detailAnchor?.path===fixture.programPath&&largeFrames.every(f=>f.detailAnchor?.path===fixture.programPath)&&zoomed.sceneKey===before.sceneKey,{detailAnchor:zoomed.detailAnchor,metadataFocus:zoomed.camera.focusPath});noOverlap(largeFrames,label+' semantic deeper zoom',true);
  const parent=zoomed.nodes.find(n=>n.path===fixture.libraryPath);const click=await page.evaluate(({x,y})=>{const svg=document.querySelector('#map-stage>svg'),p=new DOMPoint(x,y).matrixTransform(svg.getScreenCTM());return{x:p.x,y:p.y};},{x:parent.screenCx+parent.radius*.96,y:parent.screenCy});await page.mouse.click(click.x,click.y);await page.waitForFunction(p=>window.StorageAtlasCameraTest.getState().detailAnchor?.path===p,fixture.libraryPath);await settled(page);await page.waitForTimeout(500);
  const promoted=await state(page),children=promoted.nodes.filter(n=>n.parentPath===fixture.libraryPath),grandchildrenAgain=promoted.nodes.filter(n=>n.path.startsWith(fixture.libraryPath+'\\')&&n.parentPath!==fixture.libraryPath);
  check(label+': clicking immediate child unfolds its own immediate contents',promoted.detailAnchor?.path===fixture.libraryPath&&children.length===2&&children.every(n=>n.visible&&n.interactive)&&children.some(n=>n.labelVisible),{anchor:promoted.detailAnchor,children:children.map(n=>({name:n.name,visible:n.visible,labelVisible:n.labelVisible}))});
  check(label+': promoted child still shields its grandchildren at rest',grandchildrenAgain.every(n=>!n.visible&&!n.interactive&&n.opacity<.025),{visibleGrandchildren:grandchildrenAgain.filter(n=>n.visible||n.interactive).map(n=>n.path)});
  await page.waitForFunction(()=>document.querySelector('#toast').hidden);await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(__dirname,'singleton-semantic-'+label+'.png')});
}
async function scenario(browser,width,height,label){
  const context=await browser.newContext({viewport:{width,height}});if(label==='compact')await context.addInitScript(()=>{Element.prototype.requestFullscreen=()=>Promise.reject(new Error('Synthetic fallback verification'));});await fixture.install(context,requests);const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push({label,message:e.message}));
  try{
    await page.goto(fixture.origin,{waitUntil:'networkidle'});await page.waitForFunction(()=>window.StorageAtlasCameraTest?.getState().nodes.some(n=>n.interactive));await page.waitForTimeout(200);
    await listClick(page,fixture.singletonPaths[0]);await page.waitForFunction(p=>window.StorageAtlasCameraTest.getState().camera.focusPath===p,fixture.singletonPaths[0]);await settled(page);await page.evaluate(()=>window.scrollTo(0,0));
    await page.waitForFunction(selector=>{const el=document.querySelector(selector);return el&&getComputedStyle(el).display!=='none'&&el.getBoundingClientRect().width>0;},TRAIL);
    await page.waitForTimeout(500);const singletonRest=await state(page),firstChild=singletonRest.nodes.find(n=>n.path===fixture.singletonPaths[1]),tooDeep=singletonRest.nodes.filter(n=>n.path.startsWith(fixture.singletonPaths[1]+'\\'));
    check(label+': singleton click first exposes only its immediate folder',singletonRest.detailAnchor?.path===fixture.singletonPaths[0]&&firstChild?.visible&&firstChild.interactive&&firstChild.labelVisible&&tooDeep.every(n=>!n.visible&&!n.interactive),{anchor:singletonRest.detailAnchor,firstChild:firstChild&&{visible:firstChild.visible,interactive:firstChild.interactive,labelVisible:firstChild.labelVisible},visibleDeeper:tooDeep.filter(n=>n.visible||n.interactive).map(n=>n.path)});
    const initial=await state(page);await page.evaluate(()=>window.__qaChainSvg=document.querySelector('#map-stage>svg'));
    const inward=await gesture(page,label+' fast inward wheel',Array(18).fill(-80),900,fixture.singletonPaths);continuity(inward,fixture.singletonPaths,fixture.singletonNames,label+' inward',{monotone:true});noOverlap(inward,label+' inward');
    check(label+': wheel paints intermediate scales without replacing the scene',new Set(inward.map(f=>f.camera.scale.toFixed(3))).size>10&&inward.every(f=>f.sceneKey===initial.sceneKey)&&await page.evaluate(()=>document.querySelector('#map-stage>svg')===window.__qaChainSvg));
    const pauseFrames=await paused(page,label+' pause');continuity(pauseFrames,fixture.singletonPaths,fixture.singletonNames,label+' paused');noOverlap(pauseFrames,label+' paused');
    const trailBounds=await page.locator(TRAIL).boundingBox(),stageBounds=await page.locator('#map-stage').boundingBox();check(label+': trail fits inside map viewport',trailBounds.x>=stageBounds.x&&trailBounds.y>=stageBounds.y&&trailBounds.x+trailBounds.width<=stageBounds.x+stageBounds.width+1&&trailBounds.y+trailBounds.height<=stageBounds.y+stageBounds.height+1,{trailBounds,stageBounds});
    await trailInteractions(page,label);
    const ancestor=trailRow(page,'Steam');
    await ancestor.scrollIntoViewIfNeeded();await record(page,label+' ancestor click');await ancestor.click();await page.waitForFunction(p=>window.StorageAtlasCameraTest.getState().camera.focusPath===p,fixture.singletonPaths[2]);const clicked=await state(page);check(label+': ancestor row click immediately identifies intended folder',clicked.camera.focusPath===fixture.singletonPaths[2]&&clicked.route.path===fixture.singletonPaths[2],{focusPath:clicked.camera.focusPath,route:clicked.route});await page.waitForTimeout(700);const clickedFrames=await finish(page),afterClick=clickedFrames.filter(f=>f.frame>clicked.frame);check(label+': clicked folder stays pinned through animated focus and pause',afterClick.length>=8&&afterClick.every(f=>f.camera.focusPath===fixture.singletonPaths[2]&&f.trail.rows.at(-1)?.path===fixture.singletonPaths[2]),{frames:afterClick.length,focusPaths:[...new Set(afterClick.map(f=>f.camera.focusPath))],trailEndpoints:[...new Set(afterClick.map(f=>f.trail.rows.at(-1)?.path))]});noOverlap(clickedFrames,label+' ancestor click');check(label+': ancestor click retains SVG and scene',clicked.sceneKey===initial.sceneKey&&await page.evaluate(()=>document.querySelector('#map-stage>svg')===window.__qaChainSvg));
    const reverse=await gesture(page,label+' reverse wheel',Array(4).fill(50));continuity(reverse,fixture.singletonPaths,fixture.singletonNames,label+' reverse',{minDepth:1,rootMayRetire:true});noOverlap(reverse,label+' reverse');
    await page.locator('.camera-controls [aria-label="Fit all bubbles"]').click();await settled(page);await page.waitForFunction(()=>!window.StorageAtlasCameraTest.getState().route.path);
    await listClick(page,fixture.documentsPath);await settled(page);await page.waitForTimeout(700);const balanced=await page.locator(TRAIL).evaluate(el=>getComputedStyle(el).display!=='none'&&el.getBoundingClientRect().width>0);check(label+': balanced sibling view has no concentrated chain trail',!balanced);
    await page.locator('.camera-controls [aria-label="Fit all bubbles"]').click();await settled(page);await page.waitForFunction(()=>!window.StorageAtlasCameraTest.getState().route.path);await listClick(page,fixture.dominantPaths[0]);await settled(page);await page.waitForTimeout(200);await page.evaluate(()=>window.scrollTo(0,0));
    const dominant=await gesture(page,label+' dominant-child wheel',Array(13).fill(-80),900,fixture.dominantPaths);continuity(dominant,fixture.dominantPaths,fixture.dominantNames,label+' dominant',{minDepth:5,monotone:true});noOverlap(dominant,label+' dominant');check(label+': small sibling files never masquerade as chain folders',dominant.every(f=>f.trail.rows.every(row=>!row.name.includes('Small Sibling'))));
    await page.screenshot({path:path.join(__dirname,'singleton-dominant-'+label+'.png')});
    await semanticHierarchy(page,label);
  }catch(e){check(label+': focused continuity suite completes',false,{message:e.message,stack:e.stack,state:await state(page).catch(()=>null)});await page.screenshot({path:path.join(__dirname,'singleton-labels-'+label+'-failure.png')});}
  finally{await context.close();}
}
async function run(){
  const browser=await pw.chromium.launch({headless:true,...(arg('--chrome')?{executablePath:arg('--chrome')}:{})});
  try{await scenario(browser,1440,1050,'wide');await scenario(browser,445,590,'compact');}
  finally{await browser.close();check('label tests made no server or native mutation requests',requests.every(r=>['GET','HEAD'].includes(r.method)),requests.filter(r=>!['GET','HEAD'].includes(r.method)));check('label tests have no uncaught JavaScript errors',errors.length===0,errors);const report={passed:checks.filter(c=>c.passed).length,failed:checks.filter(c=>!c.passed).length,checks};fs.writeFileSync(path.join(__dirname,'singleton-labels-report.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(__dirname,'singleton-labels-frames.json'),JSON.stringify(recordings));process.stdout.write(`Result: ${report.passed} passed, ${report.failed} failed\n`);process.exitCode=report.failed?1:0;}
}
run().catch(e=>{process.stderr.write(e.stack+'\n');process.exitCode=1;});
