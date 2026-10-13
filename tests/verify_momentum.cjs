/* Real pointer/wheel input against the production camera, entirely in memory. */
'use strict';
const fs=require('fs'),path=require('path');
const args=process.argv.slice(2),arg=(key,fallback)=>args.includes(key)?args[args.indexOf(key)+1]:fallback;
const pw=require(arg('--playwright-module','playwright')),ui=path.resolve(__dirname,'../ui');
const checks=[],errors=[],metrics=[],requests=[];
function check(name,ok,detail){checks.push({name,passed:!!ok,...(detail===undefined?{}:{detail})});process.stdout.write(`${ok?'PASS':'FAIL'} ${name}\n`);if(!ok&&detail!==undefined)process.stdout.write(JSON.stringify(detail)+'\n');}
const state=page=>page.evaluate(()=>window.__momentumCamera.getState());
async function setup(browser,reducedMotion='no-preference'){
  const context=await browser.newContext({viewport:{width:1000,height:800},reducedMotion});
  await context.route('**/*',route=>{requests.push(route.request().url());return route.abort();});
  const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  await page.setContent('<style>html,body{margin:0;background:#111;color:white}body{height:1300px}#map-stage{position:relative;margin:20px;width:900px;height:650px;overflow:hidden;touch-action:none}#map-stage>svg{display:block;width:100%;height:100%;overflow:hidden}.bubble-camera-labels,.camera-controls,.camera-folder-trail{display:none!important}</style><div id="map-stage"></div>');
  for(const file of ['vendor/d3-hierarchy.min.js','bubble-layout.js','bubble-camera.js'])await page.addScriptTag({path:path.join(ui,file)});
  await page.evaluate(()=>{
    const camera=window.StorageAtlasBubbleCamera.create({stage:document.querySelector('#map-stage'),color:()=> '#9184c7',formatBytes:String,coalesce:a=>a,fetchChildren:()=>null});window.__momentumCamera=camera;
    window.__configureMomentum=scale=>{
      camera.setScene([{name:'Large',path:'Q:\\Momentum\\large.bin',kind:'file',size:1000},{name:'Medium',path:'Q:\\Momentum\\medium.bin',kind:'file',size:350},{name:'Small',path:'Q:\\Momentum\\small.bin',kind:'file',size:90}],{title:'Virtual motion fixture'},'momentum-'+scale,true);
      // Identical screen geometry at normal and tiny-world/high zoom sizes.
      camera.nodes.forEach(n=>{n.x=n.targetX=n.x/scale;n.y=n.targetY=n.y/scale;n.radius/=scale;});
      camera.worldWidth/=scale;camera.worldHeight/=scale;camera.camera={x:0,y:0,scale,targetX:0,targetY:0,targetScale:scale};camera.lastFrame=performance.now();window.__momentumEvents=[];
    };
    for(const type of ['wheel','pointermove'])camera.stage.addEventListener(type,event=>{const s=camera.getState();if(s.inputImpulse?.time===event.timeStamp)window.__momentumEvents.push({eventType:type,...s});});
    window.__startMomentumFrames=()=>{window.__momentumFrames={running:true,frames:[]};function sample(time){if(!window.__momentumFrames.running)return;const s=camera.getState(),dom=camera.nodes.filter(n=>n.visible).map(n=>{const m=n.circle.getScreenCTM(),r=Number(n.circle.getAttribute('r'));return{id:n.id,area:Math.PI*r*r*Math.abs(m.a*m.d-m.b*m.c),cx:m.e,cy:m.f};});window.__momentumFrames.frames.push({time,...s,dom});requestAnimationFrame(sample);}requestAnimationFrame(sample);};
  });
  return {context,page};
}
async function reset(page,scale){await page.evaluate(scale=>window.__configureMomentum(scale),scale);await page.waitForFunction(()=>window.__momentumCamera.getState().nodes.every(n=>n.visible));await page.mouse.move(310,390);}
async function record(page){await page.evaluate(()=>window.__startMomentumFrames());}
async function frames(page){return page.evaluate(()=>{window.__momentumFrames.running=false;return window.__momentumFrames.frames;});}
function commandMagnitude(snapshot){return snapshot.nodes.reduce((sum,n)=>sum+Math.hypot(n.inputImpulseX,n.inputImpulseY)/n.worldRadius,0)/snapshot.nodes.length;}
function signedCommand(snapshot){const m=snapshot.inputImpulse;return snapshot.nodes.every(n=>{const dx=m.kind==='wheel'?(n.screenCx-m.anchorX)*m.sign:m.velocityX,dy=m.kind==='wheel'?(n.screenCy-m.anchorY)*m.sign:m.velocityY;return dx*n.inputImpulseX+dy*n.inputImpulseY>0;});}
function paintedResponse(recording){
  const event=recording.event,early=recording.frames.filter(f=>f.time>=event.inputImpulse.time&&f.time<=event.inputImpulse.time+150);
  const nodes=event.nodes.map(base=>{
    const length=Math.hypot(base.inputImpulseX,base.inputImpulseY),ux=base.inputImpulseX/length,uy=base.inputImpulseY/length;let peak=-Infinity;
    for(const frame of early){const n=frame.nodes.find(n=>n.id===base.id);if(!n)continue;const projection=((n.offsetX-base.offsetX)*ux+(n.offsetY-base.offsetY)*uy)*n.motionScale*frame.camera.scale;peak=Math.max(peak,projection);}
    return {name:base.name,peak};
  });
  return {frames:early.length,nodes,mean:nodes.reduce((sum,n)=>sum+n.peak,0)/nodes.length};
}
function geometry(samples,label){
  let maxOffset=0,maxShape=0,maxAreaError=0,maxDetError=0,minGap=Infinity,independent=false,paintedMotion=0,domError=0;const radii=new Map();
  for(const s of samples){const group=s.nodes.filter(n=>n.visible),scale=group[0]?.radius**2/group[0]?.size;
    for(const n of group){maxOffset=Math.max(maxOffset,Math.hypot(n.offsetX,n.offsetY)*n.motionScale*s.camera.scale);maxShape=Math.max(maxShape,n.radius*(Math.max(n.shapeScaleX,n.shapeScaleY)-1));maxAreaError=Math.max(maxAreaError,Math.abs(n.radius**2/n.size/scale-1));maxDetError=Math.max(maxDetError,Math.abs(n.determinant-1));if(radii.has(n.id))maxAreaError=Math.max(maxAreaError,Math.abs(n.worldRadius/radii.get(n.id)-1));else radii.set(n.id,n.worldRadius);paintedMotion=Math.max(paintedMotion,Math.hypot(n.offsetX,n.offsetY)*n.motionScale*s.camera.scale);const dom=s.dom.find(d=>d.id===n.id);if(dom){domError=Math.max(domError,Math.hypot(dom.cx-20-n.screenCx,dom.cy-20-n.screenCy));maxDetError=Math.max(maxDetError,Math.abs(dom.area/(Math.PI*n.radius**2)-1));}}
    for(let i=0;i<group.length;i++)for(let j=i+1;j<group.length;j++){const a=group[i],b=group[j];minGap=Math.min(minGap,Math.hypot(a.screenCx-b.screenCx,a.screenCy-b.screenCy)-a.radius*Math.max(a.shapeScaleX,a.shapeScaleY)-b.radius*Math.max(b.shapeScaleX,b.shapeScaleY));independent||=Math.hypot(a.offsetX-b.offsetX,a.offsetY-b.offsetY)>1e-7;}
  }
  check(label+': actual spring motion is independently painted',samples.length>=3&&paintedMotion>.05&&independent,{frames:samples.length,paintedMotion,independent});
  check(label+': camera and screen-space paint use the same centers',domError<.001,{domError});
  check(label+': byte areas and reciprocal ellipse areas remain exact',maxAreaError<1e-12&&maxDetError<1e-6,{maxAreaError,maxDetError});
  check(label+': positional and shape jiggle retain their screen caps',maxOffset<=6.4&&maxShape<=2,{maxOffset,maxShape});
  check(label+': moving sibling bubbles retain positive gaps',minGap>0,{minGap});
  return {maxOffset,maxShape,maxAreaError,maxDetError,minGap};
}
async function drag(page,scale,delay,dx){
  await reset(page,scale);await page.mouse.down();await page.waitForTimeout(delay);await record(page);await page.mouse.move(310+dx,390);const event=await page.evaluate(()=>window.__momentumEvents.at(-1));await page.mouse.up();await page.waitForTimeout(240);return {event,frames:await frames(page)};
}
async function wheel(page,scale,delay,delta){
  await reset(page,scale);await page.mouse.wheel(0,Math.sign(delta));await page.waitForTimeout(delay);await record(page);await page.mouse.wheel(0,delta);await page.waitForFunction(()=>window.__momentumEvents.filter(s=>s.eventType==='wheel').length>=2);const event=await page.evaluate(()=>window.__momentumEvents.at(-1));await page.waitForTimeout(240);return {event,frames:await frames(page)};
}
async function scenario(browser,label,scale){
  const {context,page}=await setup(browser);try{
    const slow=await drag(page,scale,300,42),fast=await drag(page,scale,25,42),reverse=await drag(page,scale,25,-42);
    check(label+': drag momentum uses measured pixels per second',slow.event.inputImpulse.kind==='pan'&&slow.event.inputImpulse.elapsed>260&&fast.event.inputImpulse.elapsed<130&&fast.event.inputImpulse.speed>slow.event.inputImpulse.speed*2,{slow:slow.event.inputImpulse,fast:fast.event.inputImpulse});
    check(label+': equal-distance fast drags command stronger spring motion',commandMagnitude(fast.event)>commandMagnitude(slow.event)*1.5,{slow:commandMagnitude(slow.event),fast:commandMagnitude(fast.event)});
    check(label+': each bubble is driven in both drag directions',signedCommand(fast.event)&&signedCommand(reverse.event)&&fast.event.inputImpulse.velocityX>0&&reverse.event.inputImpulse.velocityX<0);
    const paintedSlow=paintedResponse(slow),paintedFast=paintedResponse(fast),paintedReverse=paintedResponse(reverse);
    check(label+': equal-distance fast drags visibly jiggle more than slow drags',paintedFast.frames>=3&&paintedSlow.frames>=3&&paintedFast.mean>paintedSlow.mean*1.3,{slow:paintedSlow,fast:paintedFast});
    check(label+': early painted offsets follow both drag directions',paintedFast.nodes.every(n=>n.peak>.08)&&paintedReverse.nodes.every(n=>n.peak>.08),{forward:paintedFast,reverse:paintedReverse});
    const zoomSlow=await wheel(page,scale,110,-25),zoomFast=await wheel(page,scale,18,-25),zoomOut=await wheel(page,scale,18,25);
    check(label+': wheel rate uses measured time and preserves zoom sign',zoomSlow.event.inputImpulse.kind==='wheel'&&zoomFast.event.inputImpulse.speed>zoomSlow.event.inputImpulse.speed*1.5&&zoomFast.event.inputImpulse.sign===1&&zoomOut.event.inputImpulse.sign===-1,{slow:zoomSlow.event.inputImpulse,fast:zoomFast.event.inputImpulse,out:zoomOut.event.inputImpulse});
    check(label+': faster wheel samples command stronger independent motion',commandMagnitude(zoomFast.event)>commandMagnitude(zoomSlow.event)*1.25,{slow:commandMagnitude(zoomSlow.event),fast:commandMagnitude(zoomFast.event)});
    check(label+': zoom-in moves radially outward and zoom-out inward',signedCommand(zoomFast.event)&&signedCommand(zoomOut.event));
    const paintedWheelSlow=paintedResponse(zoomSlow),paintedWheelFast=paintedResponse(zoomFast),paintedWheelOut=paintedResponse(zoomOut);
    check(label+': faster wheel input paints a stronger response',paintedWheelFast.mean>paintedWheelSlow.mean*1.2,{slow:paintedWheelSlow,fast:paintedWheelFast});
    check(label+': painted bubbles move outward/inward with wheel direction',paintedWheelFast.nodes.every(n=>n.peak>.08)&&paintedWheelOut.nodes.every(n=>n.peak>.08),{inward:paintedWheelOut,outward:paintedWheelFast});
    const measured=geometry([...slow.frames,...fast.frames,...reverse.frames,...zoomSlow.frames,...zoomFast.frames,...zoomOut.frames],label);check(label+': map consumes genuine wheel events without page scrolling',await page.evaluate(()=>window.scrollY)===0);
    metrics.push({label,scale,slow:slow.event.inputImpulse,fast:fast.event.inputImpulse,wheelSlow:zoomSlow.event.inputImpulse,wheelFast:zoomFast.event.inputImpulse,paintedSlow,paintedFast,paintedReverse,paintedWheelSlow,paintedWheelFast,paintedWheelOut,...measured});
  }catch(e){check(label+': momentum scenario completes',false,{message:e.message,stack:e.stack});}finally{await context.close();}
}
async function reducedScenario(browser,label,scale){
  const {context,page}=await setup(browser,'reduce');try{
    check(label+': browser actually reports its reduced-motion preference',await page.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches));
    await reset(page,scale);await page.mouse.down();await page.waitForTimeout(25);await page.mouse.move(360,420);await page.mouse.up();await page.mouse.wheel(0,-100);await page.waitForTimeout(100);const reduced=await state(page);
    check(label+': reduced motion disables positional and shape jiggle',reduced.inputImpulse.strength===0&&reduced.nodes.every(n=>n.offsetX===0&&n.offsetY===0&&n.velocityX===0&&n.velocityY===0&&n.shapeScaleX===1&&n.shapeScaleY===1),{input:reduced.inputImpulse,nodes:reduced.nodes.map(n=>({offsetX:n.offsetX,offsetY:n.offsetY,velocityX:n.velocityX,velocityY:n.velocityY,shapeScaleX:n.shapeScaleX,shapeScaleY:n.shapeScaleY}))});
  }catch(e){check(label+': reduced-motion scenario completes',false,{message:e.message,stack:e.stack});}finally{await context.close();}
}
async function run(){
  try{
    for(const [type,options,label] of [[pw.chromium,arg('--chrome')?{executablePath:arg('--chrome')}:{},'chromium'],...(!args.includes('--chromium-only')?[[pw.firefox,{channel:'moz-firefox',firefoxUserPrefs:{'ui.prefersReducedMotion':0}},'firefox']]:[])]){
      const browser=await type.launch({headless:true,...options});try{for(const scale of [1,5000])await scenario(browser,label+' zoom'+scale,scale);}finally{await browser.close();}
      // Firefox BiDi does not implement page.emulateMedia for reduced motion.
      // Use a separate, temporary browser with its native preference enabled.
      const reducedBrowser=await type.launch({headless:true,...options,...(label==='firefox'?{firefoxUserPrefs:{'ui.prefersReducedMotion':1}}:{})});try{for(const scale of [1,5000])await reducedScenario(reducedBrowser,label+' zoom'+scale,scale);}finally{await reducedBrowser.close();}
    }
  }finally{check('momentum tests perform no network or native actions',requests.length===0,requests);check('momentum tests have no JavaScript errors',errors.length===0,errors);const report={passed:checks.filter(c=>c.passed).length,failed:checks.filter(c=>!c.passed).length,checks,metrics};fs.writeFileSync(path.join(__dirname,'momentum-report.json'),JSON.stringify(report,null,2));process.stdout.write(`Result: ${report.passed} passed, ${report.failed} failed\n`);process.exitCode=report.failed?1:0;}
}
run().catch(e=>{process.stderr.write(e.stack+'\n');process.exitCode=1;});
