/* Steam menu contracts use virtual inventories and intercepted native launches. */
'use strict';
const fs=require('fs'),path=require('path'),fixture=require('./singleton_fixture.cjs');
const args=process.argv.slice(2),arg=(key,fallback)=>args.includes(key)?args[args.indexOf(key)+1]:fallback;
const pw=require(arg('--playwright-module','playwright')),checks=[],errors=[],requests=[],launches=[];
const steamRoot=fixture.nodeMap.get(fixture.firstGamePath.toLowerCase());
const secondGame=fixture.nodeMap.get(path.win32.join(fixture.commonPath,'Game Two').toLowerCase());
const steam={name:'Game One',path:steamRoot.path,installationPath:steamRoot.path,size:steamRoot.size,files:steamRoot.fileCount,source:'Steam manifest',steamAppId:'480'};
const epic={name:'Game Two',path:secondGame.path,installationPath:secondGame.path,size:secondGame.size,files:secondGame.fileCount,source:'Epic manifest'};
function check(name,ok,detail){checks.push({name,passed:!!ok,...(detail===undefined?{}:{detail})});process.stdout.write(`${ok?'PASS':'FAIL'} ${name}\n`);if(!ok&&detail!==undefined)process.stdout.write(JSON.stringify(detail)+'\n');}
const row=(page,name)=>page.locator('.list-row').filter({has:page.locator('.row-title',{hasText:new RegExp('^'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')})});
const action=page=>page.locator('#context-menu button[data-action="steam-library"]');
async function menu(page,name){await row(page,name).click({button:'right'});await page.locator('#context-menu').waitFor({state:'visible'});}
async function ready(page){await page.goto(fixture.origin,{waitUntil:'networkidle'});await page.locator('.nav-item[data-mode="games"]').click();await row(page,'Game One').waitFor();}
async function runBrowser(label,browser){
  const context=await browser.newContext({viewport:{width:1440,height:1050},reducedMotion:'reduce'});let games=[steam,epic],launchError=false,partialRoot=null;
  // Stock Firefox BiDi can omit intercepted request bodies; independently
  // capture the real fetch arguments before returning the virtual response.
  await context.addInitScript(()=>{const original=window.fetch;window.__steamRequests=[];window.fetch=function(input,options){if(String(input).includes('/api/steam-library'))window.__steamRequests.push(JSON.parse(options.body));return original.apply(this,arguments);};});
  await fixture.install(context,requests);
  await context.route('**/api/**',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.pathname==='/api/overview'&&req.method()==='GET'){const partial=partialRoot?{roots:[{...partialRoot,children:undefined,parent:''}],size:partialRoot.size}:{};return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...fixture.overview,...partial,games})});}
    if(partialRoot&&url.pathname==='/api/node'&&!url.searchParams.get('path'))return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({path:'',name:'All scanned locations',kind:'folder',size:partialRoot.size,children:[{...partialRoot,children:undefined,parent:''}],totalChildren:1,childrenSizeTotal:partialRoot.size,state:'complete'})});
    if(req.method()==='POST'){
      const body=req.postDataJSON()||await page.evaluate(()=>window.__steamRequests.at(-1));launches.push({browser:label,endpoint:url.pathname,body});
      return route.fulfill({status:launchError?400:200,contentType:'application/json',body:JSON.stringify(launchError?{error:'Steam is unavailable in this fixture.'}:{opened:true,steamAppId:'480'})});
    }
    return route.fallback();
  });
  const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push({browser:label,message:e.message}));
  try{
    await ready(page);await menu(page,'Game One');
    check(label+': recognized Steam game offers View in Steam',await action(page).count()===1&&await action(page).isEnabled());
    check(label+': menu describes the actual Steam game',await action(page).getAttribute('title')==='Open Game One in your Steam library.');
    const before=launches.length;await action(page).click();await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('Steam library'));
    check(label+': click sends the exact scanned game path without a user URL or AppID',launches.length===before+1&&launches.at(-1).endpoint==='/api/steam-library'&&JSON.stringify(launches.at(-1).body)===JSON.stringify({path:steamRoot.path}),launches.at(-1));
    check(label+': successful launch closes the menu',await page.locator('#context-menu').isHidden());
    const point=await page.evaluate(location=>{const n=window.StorageAtlasCameraTest.getState().nodes.find(n=>n.path===location);const p=new DOMPoint(n.screenCx+n.radius*.96,n.screenCy).matrixTransform(document.querySelector('#map-stage>svg').getScreenCTM());return{x:p.x,y:p.y};},steamRoot.path);
    await page.mouse.click(point.x,point.y,{button:'right'});await page.locator('#context-menu').waitFor({state:'visible'});
    check(label+': Steam game bubble has the same native library action',await action(page).count()===1);
    await page.keyboard.press('Escape');await row(page,'Game One').click();await row(page,'Readme.txt').waitFor();await menu(page,'Readme.txt');
    check(label+': game contents resolve to their Steam installation',await action(page).count()===1);
    await page.locator('#context-menu button[data-action="tree"]').click();await page.locator('#tree-dialog').waitFor({state:'visible'});
    await page.locator('.tree-row').filter({has:page.locator('.tree-name',{hasText:'Readme.txt'})}).click({button:'right'});await page.locator('#context-menu').waitFor({state:'visible'});
    check(label+': traditional tree also exposes the Steam connection',await action(page).count()===1);
    await page.keyboard.press('Escape');await page.locator('#tree-dialog .close-dialog').click();
    await row(page,'Content').click({modifiers:['Shift']});await row(page,'Readme.txt').click({modifiers:['Shift']});await menu(page,'Readme.txt');const batchBefore=launches.length;await action(page).click();await page.waitForTimeout(100);
    check(label+': batch context opens only the right-clicked game connection',launches.length===batchBefore+1&&launches.at(-1).body.path===path.win32.join(steamRoot.path,'Readme.txt'));
    await page.locator('.nav-item[data-mode="games"]').click();await menu(page,'Game Two');
    check(label+': Epic installation has no Steam action',await action(page).count()===0);await page.keyboard.press('Escape');
    for(const [name,game] of [
      ['missing AppID',{...steam,steamAppId:undefined}],
      ['malformed AppID',{...steam,steamAppId:'480/../../run/999'}],
      ['newline AppID',{...steam,steamAppId:'480\n'}],
      ['overflow AppID',{...steam,steamAppId:'4294967296'}],
      ['fallback game',{...steam,source:'Known game folder'}],
      ['partial scanned installation',{...steam,path:path.win32.join(steamRoot.path,'Content'),size:400000}]
    ]){
      games=[game,epic];await ready(page);await menu(page,'Game One');
      check(label+': '+name+' uses only a validated Steam connection',await action(page).count()===(name==='partial scanned installation'?1:0));await page.keyboard.press('Escape');
    }
    partialRoot=fixture.nodeMap.get(path.win32.join(steamRoot.path,'Content').toLowerCase());games=[{...steam,path:partialRoot.path,size:partialRoot.size}];await ready(page);await menu(page,'Game One');
    check(label+': truly partial scan root connects to the unscanned installation ancestor',await action(page).count()===1&&await page.locator('#context-menu button[data-action="rename"]').isDisabled());await page.keyboard.press('Escape');await row(page,'Game One').click();await menu(page,'Worlds.pak');
    check(label+': truly partial scan descendant retains Steam library identity',await action(page).count()===1);await page.keyboard.press('Escape');
    partialRoot=null;
    games=[steam,epic];launchError=true;await ready(page);await menu(page,'Game One');await action(page).click();await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('Steam is unavailable'));
    check(label+': native launch errors remain visible',await page.locator('#toast').textContent()==='Steam is unavailable in this fixture.');
    await page.screenshot({path:path.join(__dirname,'steam-'+label+'.png')});
  }catch(e){check(label+': Steam menu suite completes',false,{message:e.message});await page.screenshot({path:path.join(__dirname,'steam-'+label+'-failure.png')});}
  finally{await context.close();await browser.close();}
}
async function run(){
  await runBrowser('chromium',await pw.chromium.launch({headless:true,...(arg('--chrome')?{executablePath:arg('--chrome')}:{})}));
  await runBrowser('firefox',await pw.firefox.launch({channel:'moz-firefox',headless:true}));
  check('Steam menus cause no uncaught JavaScript errors',errors.length===0,errors);
  check('Every native request is an intercepted Steam view action',launches.length>0&&launches.every(r=>r.endpoint==='/api/steam-library'),launches);
  check('No virtual test requests scans, deletion, rename or file execution',requests.every(r=>r.method==='GET'||r.method==='HEAD'),requests.filter(r=>r.method!=='GET'&&r.method!=='HEAD'));
  const report={passed:checks.filter(c=>c.passed).length,failed:checks.filter(c=>!c.passed).length,checks,launches};fs.writeFileSync(path.join(__dirname,'steam-report.json'),JSON.stringify(report,null,2));process.stdout.write(`Result: ${report.passed} passed, ${report.failed} failed\n`);process.exitCode=report.failed?1:0;
}
run().catch(e=>{process.stderr.write(e.stack+'\n');process.exitCode=1;});
