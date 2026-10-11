/* Real raster contours from production SVG paint; no server or real inventory. */
'use strict';
const fs=require('fs'),path=require('path');
const args=process.argv.slice(2),arg=(key,fallback)=>args.includes(key)?args[args.indexOf(key)+1]:fallback;
const modulePath=arg('--playwright-module','playwright'),pw=require(modulePath);
const {PNG}=require(path.join(path.dirname(require.resolve(modulePath)),'../pngjs'));
const checks=[],metrics=[],errors=[];
function check(name,ok,detail){checks.push({name,passed:!!ok,...(detail===undefined?{}:{detail})});process.stdout.write(`${ok?'PASS':'FAIL'} ${name}\n`);if(!ok&&detail!==undefined)process.stdout.write(JSON.stringify(detail)+'\n');}
const ui=path.resolve(__dirname,'../ui');
async function stage(browser){
  const context=await browser.newContext({viewport:{width:800,height:800},deviceScaleFactor:1,reducedMotion:'reduce'});
  await context.route('**/*',route=>route.abort());
  const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
  await page.setContent('<style>html,body{margin:0;background:#000}#map-stage{position:relative;width:800px;height:800px;overflow:hidden}#map-stage>svg{display:block;width:800px;height:800px;overflow:hidden}.bubble-camera-labels,.camera-controls,.camera-folder-trail{display:none!important}</style><div id="map-stage"></div>');
  await page.addScriptTag({path:path.join(ui,'vendor/d3-hierarchy.min.js')});await page.addScriptTag({path:path.join(ui,'bubble-layout.js')});await page.addScriptTag({path:path.join(ui,'bubble-camera.js')});
  await page.evaluate(()=>{
    const c=window.StorageAtlasBubbleCamera.create({stage:document.querySelector('#map-stage'),color:()=> '#ffffff',formatBytes:n=>String(n),coalesce:a=>a,fetchChildren:()=>null});window.__renderCamera=c;
    window.__configureRender=options=>{
      cancelAnimationFrame(c.raf);const count=options.pair?2:1,items=Array.from({length:count},(_,i)=>({name:'Circle '+i,path:'Q:\\Pixel QA\\Circle '+i,kind:'file',category:'Other',size:i?4:1,fileCount:1,folderCount:0}));
      c.setScene(items,{title:'Raster fixture'},JSON.stringify(options),true);cancelAnimationFrame(c.raf);
      const scale=options.scale,baseX=123.456789,baseY=210.7654321,x=(options.cx??400)-baseX*scale,y=(options.cy??400)-baseY*scale;
      c.camera={x,y,targetX:x,targetY:y,scale,targetScale:scale};
      c.nodes.forEach((n,i)=>{const cx=options.pair?(i?500:230):(options.cx??400),cy=options.cy??400;n.x=n.targetX=(cx-x)/scale;n.y=n.targetY=(cy-y)/scale;n.radius=options.worldRadius*(i?2:1);n.offsetX=n.offsetY=n.velocityX=n.velocityY=n.wobble=n.wobbleVelocity=0;});
      c.lastFrame=performance.now();c.tick(performance.now());cancelAnimationFrame(c.raf);return window.__renderSnapshot();
    };
    window.__renderSnapshot=()=>{cancelAnimationFrame(c.raf);return{...c.getState(),dom:c.nodes.map(n=>{const m=n.circle.getScreenCTM(),r=n.circle.getAttribute('r'),fill=n.group.querySelector('.bubble-viewport-fill'),paths=[...n.group.querySelectorAll('path')].filter(p=>getComputedStyle(p).display!=='none').map(p=>({class:p.getAttribute('class'),d:p.getAttribute('d')||''}));return{path:n.item.path,r:Number(r),circleVisible:getComputedStyle(n.circle).display!=='none',rimVisible:getComputedStyle(n.rim).display!=='none',paths,matrix:m?{a:m.a,b:m.b,c:m.c,d:m.d,e:m.e,f:m.f}:null,viewportFill:fill?{visible:getComputedStyle(fill).display!=='none',x:Number(fill.getAttribute('x')),y:Number(fill.getAttribute('y')),width:Number(fill.getAttribute('width')),height:Number(fill.getAttribute('height'))}:null};})};};
    window.__resumeRender=()=>{c.lastFrame=performance.now();c.raf=requestAnimationFrame(time=>c.tick(time));};
  });
  return {context,page};
}
function ink(image,x,y){if(x<0||y<0||x>=image.width||y>=image.height)return false;const i=(y*image.width+x)*4;return Math.max(image.data[i],image.data[i+1],image.data[i+2])>40&&image.data[i+3]>100;}
function contour(buffer,node){
  const image=PNG.sync.read(buffer),r=node.radius,cx=node.screenCx,cy=node.screenCy,a=node.shapeScaleX,b=node.shapeScaleY,angle=-node.shapeAngle*Math.PI/180,cos=Math.cos(angle),sin=Math.sin(angle);
  const bound=r*Math.max(a,b)+3,left=Math.max(0,Math.floor(cx-bound)),right=Math.min(image.width-1,Math.ceil(cx+bound)),top=Math.max(0,Math.floor(cy-bound)),bottom=Math.min(image.height-1,Math.ceil(cy+bound));
  let pixels=0,boundary=0,maxRadialError=0,sumRadialError=0;
  for(let y=top;y<=bottom;y++)for(let x=left;x<=right;x++)if(ink(image,x,y)){
    pixels++;if(!ink(image,x-1,y)||!ink(image,x+1,y)||!ink(image,x,y-1)||!ink(image,x,y+1)){
      const dx=x+.5-cx,dy=y+.5-cy,ex=(dx*cos-dy*sin)/a,ey=(dx*sin+dy*cos)/b,error=Math.abs(Math.hypot(ex,ey)-r);boundary++;maxRadialError=Math.max(maxRadialError,error);sumRadialError+=error;
    }
  }
  return{pixels,boundary,maxRadialError,meanRadialError:sumRadialError/Math.max(1,boundary),areaError:Math.abs(pixels/(Math.PI*r*r)-1),cx,cy,r};
}
async function snapshot(page){const data=await page.evaluate(()=>window.__renderSnapshot()),buffer=await page.locator('#map-stage').screenshot();return{data,buffer};}
function partialContour(buffer,node){
  const image=PNG.sync.read(buffer),r=node.radius,a=node.shapeScaleX,b=node.shapeScaleY,angle=-node.shapeAngle*Math.PI/180,cos=Math.cos(angle),sin=Math.sin(angle);let errors=0,foreground=0,samples=0;
  for(let y=4;y<image.height;y+=4)for(let x=4;x<image.width;x+=4){const dx=x+.5-node.screenCx,dy=y+.5-node.screenCy,ex=(dx*cos-dy*sin)/a,ey=(dx*sin+dy*cos)/b,signed=Math.hypot(ex,ey)-r,painted=ink(image,x,y);samples++;foreground+=painted?1:0;if(Math.abs(signed)>2&&painted!==(signed<0))errors++;}
  return{errors,foreground,samples};
}
async function staticCases(page,label){
  for(const projected of [120,300])for(const worldRadius of [10,.01,.0003,.00001]){
    const scale=projected/worldRadius,name=`${label} r${worldRadius} projected${projected}`;await page.evaluate(o=>window.__configureRender(o),{worldRadius,scale});const {data,buffer}=await snapshot(page),m=contour(buffer,data.nodes[0]);metrics.push({name,worldRadius,scale,beyondProductionZoomCap:scale>1e6,...m});
    check(name+': raster outline remains a smooth circle',m.boundary>100&&m.maxRadialError<=1.9,m);check(name+': filled pixels match circular area',m.areaError<.025,m);
    if(worldRadius===.00001)fs.writeFileSync(path.join(__dirname,`rendering-${label}-${projected}.png`),buffer);
  }
  await page.evaluate(o=>window.__configureRender(o),{worldRadius:.00001,scale:1e6});const tiny=await snapshot(page),small=contour(tiny.buffer,tiny.data.nodes[0]);check(label+': tiny-world circle stays round at the actual zoom cap',small.boundary>20&&small.maxRadialError<1.9&&small.areaError<.25,small);
  await page.evaluate(o=>window.__configureRender(o),{worldRadius:1e9,scale:1e6});const giant=await snapshot(page),image=PNG.sync.read(giant.buffer),dom=giant.data.dom[0];let missing=0;for(let y=0;y<800;y++)for(let x=0;x<800;x++)if(!ink(image,x,y))missing++;
  check(label+': enclosing ancestor paints exact viewport coverage',missing===0&&!dom.circleVisible&&!dom.rimVisible&&dom.viewportFill?.visible,{missing,dom});check(label+': enclosing ancestor replaces curves with bounded viewport geometry',dom.viewportFill?.x===0&&dom.viewportFill?.y===0&&dom.viewportFill?.width===800&&dom.viewportFill?.height===800,dom);
  const radius=1e8;
  for(const scenario of [{name:'edge',cx:radius+100,cy:400},{name:'corner',cx:radius/Math.SQRT2+100,cy:radius/Math.SQRT2+100},{name:'tangent',cx:radius+798,cy:400}]){
    await page.evaluate(o=>window.__configureRender(o),{worldRadius:100,scale:1e6,cx:scenario.cx,cy:scenario.cy});const partial=await snapshot(page),m=partialContour(partial.buffer,partial.data.nodes[0]),dom=partial.data.dom[0],coords=dom.paths.flatMap(p=>(p.d.match(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi)||[]).map(Number));
    check(`${label}: huge partial ${scenario.name} paints the mathematical ellipse`,m.errors===0&&(!dom.viewportFill?.visible)&&(!dom.circleVisible)&&dom.paths.some(p=>p.class==='bubble-clipped-fill'&&p.d),{...m,dom});
    check(`${label}: huge partial ${scenario.name} uses bounded visible geometry`,coords.length>=6&&coords.every(n=>Number.isFinite(n)&&n>=-4.01&&n<=804.01),{minimum:Math.min(...coords),maximum:Math.max(...coords),coordinateCount:coords.length});metrics.push({name:label+' partial '+scenario.name,...m,dom});fs.writeFileSync(path.join(__dirname,`rendering-${label}-partial-${scenario.name}.png`),partial.buffer);if(scenario.name==='edge')fs.writeFileSync(path.join(__dirname,`rendering-${label}-partial.png`),partial.buffer);
  }
}
async function springCases(page,label){
  await page.emulateMedia({reducedMotion:'no-preference'});await page.evaluate(o=>window.__configureRender(o),{worldRadius:.01,scale:6000,pair:true});const initial=await page.evaluate(()=>window.__renderSnapshot());await page.evaluate(()=>window.__resumeRender());await page.mouse.move(400,400);await page.mouse.wheel(0,-120);const frames=[];
  for(let i=0;i<7;i++){await page.waitForTimeout(25);const f=await snapshot(page);f.metrics=f.data.nodes.map(n=>contour(f.buffer,n));frames.push(f);await page.evaluate(()=>window.__resumeRender());}
  const last=frames.at(-1).data;check(label+': tiny-world wheel spring paints intermediate zoom frames',frames.filter(f=>f.data.camera.scale>initial.camera.scale+.01&&f.data.camera.scale<last.camera.targetScale-.01).length>=3,{initial:initial.camera.scale,target:last.camera.targetScale,scales:frames.map(f=>f.data.camera.scale)});
  await page.mouse.move(400,400);await page.mouse.down();await page.mouse.move(465,435,{steps:10});await page.mouse.up();
  for(let i=0;i<5;i++){await page.waitForTimeout(25);const f=await snapshot(page);f.metrics=f.data.nodes.map(n=>contour(f.buffer,n));frames.push(f);await page.evaluate(()=>window.__resumeRender());}
  await page.evaluate(()=>window.__renderSnapshot());const end=frames.at(-1).data;check(label+': tiny-world drag pans without resetting camera scale',Math.abs(end.camera.targetX-last.camera.targetX-65)<1&&Math.abs(end.camera.targetY-last.camera.targetY-35)<1&&end.camera.targetScale===last.camera.targetScale,{before:last.camera,after:end.camera});
  const maxContour=Math.max(...frames.flatMap(f=>f.metrics.map(m=>m.maxRadialError))),maxRatio=Math.max(...frames.map(f=>Math.abs((f.metrics[1].pixels/f.metrics[0].pixels)/4-1))),maxDet=Math.max(...frames.flatMap(f=>f.data.dom.map(d=>Math.abs(d.matrix.a*d.matrix.d-d.matrix.b*d.matrix.c-1))));
  check(label+': moving reciprocal ellipses keep smooth raster contours',maxContour<=2,{frames:frames.length,maxContour});check(label+': animated raster area ratio remains byte proportional',maxRatio<.05,{maxRatio});check(label+': actual projected SVG transforms preserve ellipse area',maxDet<1e-6,{maxDet});metrics.push({name:label+' spring',frames:frames.map(f=>({camera:f.data.camera,nodes:f.data.nodes,metrics:f.metrics}))});fs.writeFileSync(path.join(__dirname,`rendering-${label}-spring.png`),frames.at(-1).buffer);
}
async function browserCases(type,options,label){const browser=await type.launch({headless:true,...options});let context;try{const fixture=await stage(browser);context=fixture.context;await staticCases(fixture.page,label);await springCases(fixture.page,label);}catch(e){check(label+': rendering suite completes',false,{message:e.message,stack:e.stack});}finally{if(context)await context.close();await browser.close();}}
async function run(){try{await browserCases(pw.firefox,{channel:'moz-firefox'},'firefox');await browserCases(pw.chromium,arg('--chrome')?{executablePath:arg('--chrome')}:{},'chromium');}finally{check('isolated rendering has no uncaught JavaScript errors',errors.length===0,errors);const report={passed:checks.filter(c=>c.passed).length,failed:checks.filter(c=>!c.passed).length,checks};fs.writeFileSync(path.join(__dirname,'rendering-report.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(__dirname,'rendering-metrics.json'),JSON.stringify(metrics,null,2));process.stdout.write(`Result: ${report.passed} passed, ${report.failed} failed\n`);process.exitCode=report.failed?1:0;}}
run().catch(e=>{process.stderr.write(e.stack+'\n');process.exitCode=1;});
