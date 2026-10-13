/* Local synthetic camera profiling. Measurements describe this run, not hardware guarantees. */
'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const args=process.argv.slice(2),arg=(key,fallback)=>args.includes(key)?args[args.indexOf(key)+1]:fallback;
const pw=require(arg('--playwright-module','playwright')),fixture=require('./cluster_fixture.cjs'),ui=path.resolve(__dirname,'../ui');
const files=['vendor/d3-hierarchy.min.js','bubble-layout.js','bubble-camera.js'];
const source=files.map(name=>({name,code:fs.readFileSync(path.join(ui,name),'utf8')}));
const sourceHashes=Object.fromEntries(source.map(s=>[s.name,crypto.createHash('sha256').update(s.code).digest('hex')]));
const checks=[],metrics=[],errors=[],requests=[];
function check(name,ok,detail){checks.push({name,passed:!!ok,...(detail===undefined?{}:{detail})});process.stdout.write(`${ok?'PASS':'FAIL'} ${name}\n`);if(!ok&&detail)process.stdout.write(JSON.stringify(detail)+'\n');}
async function scenario(browser,label,count,throttle=1){
  const context=await browser.newContext({viewport:{width:1240,height:900},reducedMotion:'no-preference'});
  await context.route('**/*',route=>{requests.push(route.request().url());return route.abort();});
  const page=await context.newPage();page.on('pageerror',e=>errors.push({label,message:e.message}));
  try{
    if(throttle>1){const session=await context.newCDPSession(page);await session.send('Emulation.setCPUThrottlingRate',{rate:throttle});}
    await page.setContent('<style>html,body{margin:0}body{height:1500px;background:#111}#map-stage{position:relative;margin:20px;width:1120px;height:720px;overflow:hidden;touch-action:none}.camera-controls{position:absolute;bottom:10px}.camera-folder-trail[hidden]{display:none}.bubble-camera-labels{pointer-events:none}#map-stage>svg{width:100%;height:100%;display:block;overflow:hidden}</style><div id="map-stage"></div>');
    for(const s of source)await page.addScriptTag({content:s.code});
    await page.evaluate(items=>{
      const camera=window.StorageAtlasBubbleCamera.create({stage:document.querySelector('#map-stage'),color:()=> '#a69acb',formatBytes:n=>String(n),coalesce:items=>items,fetchChildren:()=>null});
      window.__profileCamera=camera;window.__profile={ticks:[],intervals:[],running:false};
      const tick=camera.tick.bind(camera);camera.tick=function(time){const started=performance.now(),before=camera.frame;tick(time);if(window.__profile.running){if(camera.frame!==before){window.__profile.ticks.push(performance.now()-started);window.__profile.paintTimes.push(time);}else window.__profile.skipped=(window.__profile.skipped||0)+1;}};
      camera.setScene(items,{title:'Synthetic profiler'},'profile-fixture',true);
      window.__startProfile=()=>{window.__profile={ticks:[],paintTimes:[],intervals:[],running:true,startFrame:camera.frame};let previous;function frame(time){if(!window.__profile.running)return;if(previous!==undefined)window.__profile.intervals.push(time-previous);previous=time;requestAnimationFrame(frame);}requestAnimationFrame(frame);};
      window.__stopProfile=()=>{window.__profile.running=false;const s=camera.getState();return{...window.__profile,endFrame:s.frame,performance:s.performance||null,visibleNodes:s.nodes.filter(n=>n.visible).length,nodeCount:s.nodes.length};};
    },fixture.siblings(count));
    await page.waitForTimeout(300);await page.evaluate(()=>window.__startProfile());await page.mouse.move(440,350);await page.mouse.wheel(0,-80);await page.waitForTimeout(1100);
    const measured=await page.evaluate(()=>window.__stopProfile());
    function summary(values){const a=values.slice().sort((a,b)=>a-b);return{samples:a.length,median:a[Math.floor(a.length*.5)]??null,p95:a[Math.floor(a.length*.95)]??null,max:a.at(-1)??null};}
    const metric={browser:label,siblings:count,cpuThrottle:throttle,tickMs:summary(measured.ticks),cameraPaintGapMs:summary(measured.paintTimes.slice(1).map((time,index)=>time-measured.paintTimes[index])),browserFrameGapMs:summary(measured.intervals),cameraFrames:measured.endFrame-measured.startFrame,skippedTicks:measured.skipped||0,nodeCount:measured.nodeCount,visibleNodes:measured.visibleNodes,diagnostics:measured.performance};metrics.push(metric);
    check(`${label} ${count} siblings ${throttle}x: actual camera paints during wheel input`,measured.endFrame>measured.startFrame&&measured.nodeCount===count,metric);
    check(`${label} ${count} siblings ${throttle}x: profiler records real rendering work`,measured.ticks.length>=3&&measured.intervals.length>=3);
    check(`${label} ${count} siblings ${throttle}x: wheel prevents page scroll`,await page.evaluate(()=>window.scrollY)===0);
    if(!args.includes('--baseline'))check(`${label} ${count} siblings ${throttle}x: links and scheduling remain bounded`,measured.performance.neighborLinks<=count*4&&measured.performance.textCacheEntries<=5001&&measured.performance.frameBudgetMs>=1000/60&&measured.performance.frameBudgetMs<=1000/24,measured.performance);
  }finally{await context.close();}
}
async function lifecycle(browser,label,reduced=false){
  const context=await browser.newContext({viewport:{width:1240,height:900},reducedMotion:reduced?'reduce':'no-preference'});await context.route('**/*',route=>{requests.push(route.request().url());return route.abort();});const page=await context.newPage();page.setDefaultTimeout(18000);page.on('pageerror',e=>errors.push({label,message:e.message}));
  try{await page.setContent('<style>html,body{margin:0;background:#111}body{height:2300px}#map-stage{position:relative;margin:20px;width:1120px;height:720px;overflow:hidden;touch-action:none}#map-stage>svg{display:block;width:100%;height:100%}.bubble-camera-labels,.camera-controls,.camera-folder-trail{pointer-events:none}</style><div id="map-stage"></div>');for(const s of source)await page.addScriptTag({content:s.code});await page.evaluate(items=>{window.__lifeCamera=window.StorageAtlasBubbleCamera.create({stage:document.querySelector('#map-stage'),color:()=> '#a69acb',formatBytes:String,coalesce:items=>items,fetchChildren:()=>null});window.__lifeCamera.setScene(items,{title:'Lifecycle'},'lifecycle',true);window.__startLife=()=>{window.__lifeFrames={running:true,frames:[],start:performance.now()};let previous=-1;function frame(time){const recording=window.__lifeFrames;if(!recording.running)return;const s=window.__lifeCamera.getState();if(s.frame!==previous){previous=s.frame;const stage=document.querySelector('#map-stage').getBoundingClientRect();s.dom=s.nodes.filter(n=>n.visible).map(n=>{const circle=document.querySelector(`.bubble-node[data-node-id="${n.id}"] .bubble-outer`),m=circle.getScreenCTM();return{id:n.id,cx:m.e-stage.left,cy:m.f-stage.top,area:Math.PI*Number(circle.getAttribute('r'))**2*Math.abs(m.a*m.d-m.b*m.c)};});recording.frames.push({time,...s});}requestAnimationFrame(frame);}requestAnimationFrame(frame);};},fixture.siblings(3));await page.waitForTimeout(150);await page.evaluate(()=>window.__startLife());await page.mouse.move(530,370);await page.mouse.wheel(0,-220);await page.waitForTimeout(1600);
    const recording=await page.evaluate(()=>{window.__lifeFrames.running=false;return window.__lifeFrames;}),input=recording.frames.find(f=>f.inputImpulse)?.inputImpulse;let peak=0,late=0,minGap=Infinity,maxShape=0,areaError=0,domAreaError=0,paintError=0,independent=false;const motion=[];
    for(const f of recording.frames){const nodes=f.nodes.filter(n=>n.visible),k=nodes[0]?.radius**2/nodes[0]?.size;for(const n of nodes){const offset=Math.hypot(n.offsetX,n.offsetY)*n.motionScale*f.camera.scale;peak=Math.max(peak,offset);if(f.time>input.time+300)late=Math.max(late,offset);maxShape=Math.max(maxShape,n.radius*(Math.max(n.shapeScaleX,n.shapeScaleY)-1));areaError=Math.max(areaError,Math.abs(n.radius**2/n.size/k-1),Math.abs(n.determinant-1));const d=f.dom.find(d=>d.id===n.id);if(d){paintError=Math.max(paintError,Math.hypot(d.cx-n.screenCx,d.cy-n.screenCy));domAreaError=Math.max(domAreaError,Math.abs(d.area/(Math.PI*n.radius**2)-1));}}
      for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++){const a=nodes[i],b=nodes[j];minGap=Math.min(minGap,Math.hypot(a.screenCx-b.screenCx,a.screenCy-b.screenCy)-a.radius*Math.max(a.shapeScaleX,a.shapeScaleY)-b.radius*Math.max(b.shapeScaleX,b.shapeScaleY));independent||=Math.hypot(a.offsetX-b.offsetX,a.offsetY-b.offsetY)>1e-4;}
      if(nodes[0])motion.push({time:f.time-input.time,x:nodes[0].offsetX*nodes[0].motionScale*f.camera.scale,y:nodes[0].offsetY*nodes[0].motionScale*f.camera.scale});
    }
    const lifeMetric={browser:label,reduced,paintedFrames:recording.frames.length,peakOffsetPx:peak,after300msPeakPx:late,maxShapePx:maxShape,minGapPx:minGap,areaError,domAreaError,paintError,motion};metrics.push(lifeMetric);
    // SVG CTMs use browser float precision. Logical byte ratios remain checked separately at double precision.
    check(label+': painted geometry retains exact areas and positive gaps',areaError<1e-10&&domAreaError<1e-6&&paintError<.001&&minGap>0,{...lifeMetric,motion:undefined});
    check(label+': painted motion remains within6.4px position and2px shape',peak<=6.4&&maxShape<=2,{peak,maxShape});
    if(reduced){check(label+': native reduced-motion preference removes all jiggle',await page.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches)&&peak===0&&maxShape===0);}
    else{check(label+': noticeable independent motion continues after300ms',recording.frames.length>=10&&late>=3&&independent,{frames:recording.frames.length,late,peak,independent});const early=motion.find(n=>n.time>=350),later=motion.find(n=>n.time>=1100);check(label+': slow drift remains visible across a later interval',!!early&&!!later&&Math.hypot(later.x-early.x,later.y-early.y)>.25,{early,later});}
    await page.waitForFunction(()=>!window.__lifeCamera.getState().performance.rafPending,{timeout:18000});const stopped=await page.evaluate(()=>window.__lifeCamera.getState());await page.waitForTimeout(300);const after=await page.evaluate(()=>window.__lifeCamera.getState());check(label+': resting map stops scheduling or painting frames',!after.performance.rafPending&&after.frame===stopped.frame,{before:stopped.frame,after:after.frame,diagnostics:after.performance});
    await page.evaluate(()=>window.scrollTo(0,1500));await page.waitForTimeout(150);const hidden=await page.evaluate(()=>window.__lifeCamera.getState());await page.waitForTimeout(250);const hiddenAfter=await page.evaluate(()=>window.__lifeCamera.getState());check(label+': offscreen map stops its animation work',hidden.performance.hidden&&!hiddenAfter.performance.rafPending&&hiddenAfter.frame===hidden.frame,{before:hidden.frame,after:hiddenAfter.frame,diagnostics:hiddenAfter.performance});
    await page.evaluate(()=>window.scrollTo(0,0));await page.waitForTimeout(100);await page.mouse.move(530,370);await page.mouse.wheel(0,-80);await page.waitForTimeout(100);const awake=await page.evaluate(()=>window.__lifeCamera.getState());check(label+': returning and interacting resumes actual painting',awake.frame>hiddenAfter.frame&&!awake.performance.hidden);
    for(let i=0;i<2;i++){await page.mouse.move(200,300);await page.mouse.down();await page.mouse.move(1100,300);await page.mouse.up();}await page.waitForTimeout(900);const culled=await page.evaluate(()=>window.__lifeCamera.getState());check(label+': pan outside the viewport culls bubble physics',culled.performance.visibleNodes===0&&culled.performance.animatedNodes===0,{diagnostics:culled.performance,nodes:culled.nodes.map(n=>({visible:n.visible,animated:n.animated}))});
  }catch(error){check(label+': lifecycle scenario completes',false,{message:error.message,stack:error.stack});}finally{await context.close();}
}
async function run(){
  try{
    for(const [type,options,label] of [[pw.chromium,arg('--chrome')?{executablePath:arg('--chrome')}:{},'chromium'],...(!args.includes('--chromium-only')?[[pw.firefox,{channel:'moz-firefox'},'firefox']]:[])]){
      const browser=await type.launch({headless:true,...options});try{if(!args.includes('--lifecycle-only')){for(const count of [60,240,600])await scenario(browser,label,count);if(label==='chromium'&&!args.includes('--skip-throttle'))await scenario(browser,label,240,4);}if(!args.includes('--baseline')&&!args.includes('--profile-only')&&!args.includes('--skip-lifecycle'))await lifecycle(browser,label);}finally{await browser.close();}
      if(!args.includes('--baseline')&&!args.includes('--profile-only')&&!args.includes('--skip-lifecycle')){const reducedBrowser=await type.launch({headless:true,...options,...(label==='firefox'?{firefoxUserPrefs:{'ui.prefersReducedMotion':1}}:{})});try{await lifecycle(reducedBrowser,label+' reduced',true);}finally{await reducedBrowser.close();}}
    }
  }finally{
    check('profiling contacts no native service or external network',requests.length===0,requests);check('profiling has no uncaught JavaScript errors',errors.length===0,errors);
    const report={passed:checks.filter(c=>c.passed).length,failed:checks.filter(c=>!c.passed).length,baseline:args.includes('--baseline'),scope:'Isolated browser observations on the current machine; CPU throttle is a deliberate stress condition, not a hardware benchmark.',sourceHashes,checks,metrics};
    fs.writeFileSync(path.join(__dirname,path.basename(arg('--report',args.includes('--baseline')?'performance-baseline-report.json':'performance-report.json'))),JSON.stringify(report,null,2));process.stdout.write(`Result: ${report.passed} passed, ${report.failed} failed\n`);process.exitCode=report.failed?1:0;
  }
}
run().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
