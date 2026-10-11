/* Storage Atlas: continuous world camera and progressively revealed hierarchy. */
(() => {
  'use strict';
  const NS='http://www.w3.org/2000/svg';
  const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
  const el=(tag,attrs={},text)=>{const node=document.createElementNS(NS,tag);Object.entries(attrs).forEach(([key,value])=>node.setAttribute(key,String(value)));if(text!==undefined)node.textContent=text;return node;};
  const hash=text=>{let value=2166136261;for(const char of String(text)){value^=char.charCodeAt(0);value=Math.imul(value,16777619);}return value>>>0;};
  const shade=(color,factor)=>'#'+[0,2,4].map(i=>Math.round(parseInt(color.slice(i+1,i+3),16)*factor).toString(16).padStart(2,'0')).join('');
  const smooth=value=>{value=clamp(value,0,1);return value*value*(3-2*value);};
  const glyphs={
    Folder:'<path d="M3 8V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Z"/><path d="M3 9h18"/>',
    Images:'<rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 4 4 3-3 5 5"/>',
    Videos:'<rect x="2" y="5" width="20" height="14" rx="4"/><path d="m10 9 5 3-5 3Z"/><path d="M5 8v1m0 6v1m14-8v1m0 6v1"/>',
    Audio:'<path d="M3 10v4m4-7v10m5-14v18m5-14v10m4-7v4"/>',
    Documents:'<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
    Code:'<path d="m7 6-5 6 5 6m10-12 5 6-5 6m-3-15-4 18"/>',
    Archives:'<rect x="4" y="3" width="16" height="18" rx="4"/><path d="M10 4h4m-4 3h4m-4 3h4m-4 3h4m-3 3h2v3h-2Z"/>',
    Games:'<path d="M7 7h10a4 4 0 0 1 4 4l1 6a2 2 0 0 1-3 2l-4-3H9l-4 3a2 2 0 0 1-3-2l1-6a4 4 0 0 1 4-4Z"/><path d="M7 10v5m-2.5-2.5h5M16 11h.1M19 14h.1"/>',
    Applications:'<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
    System:'<rect x="5" y="5" width="14" height="14" rx="4"/><path d="M9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3"/><rect x="9" y="9" width="6" height="6" rx="1"/>',
    Other:'<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M8 15h.1M12 15h.1M16 15h.1"/>'
  };

  class BubbleCamera {
    constructor(options){
      this.options=options;this.stage=options.stage;this.nodes=[];this.roots=[];this.serial=0;this.frame=0;this.sceneKey='';this.focusNode=null;this.focusCandidate=null;this.focusCandidateAt=0;this.hasInteracted=false;this.lastInput=0;this.pending=[];this.inFlight=0;this.alive=true;this.pointer=null;this.activeHover=null;this.width=Math.max(1,this.stage.clientWidth);this.height=Math.max(1,this.stage.clientHeight);this.worldWidth=this.width;this.worldHeight=this.height;
      this.camera={x:0,y:0,scale:1,targetX:0,targetY:0,targetScale:1};this.lastWheelTime=0;this.inputImpulse=null;this.detailFocusPath=new Set();this.detailFocusDimension=0;this.selectedPaths=new Set();this.textMeasure=document.createElement('canvas').getContext('2d');this.textWidthCache=new Map();
      this.svg=el('svg',{class:'bubble-camera-svg',role:'group','aria-label':'Interactive storage bubbles',viewBox:`0 0 ${this.width} ${this.height}`});
      this.defs=el('defs');this.world=el('g',{class:'bubble-camera-world'});this.labels=el('g',{class:'bubble-camera-labels','pointer-events':'none'});this.svg.append(this.defs,this.world,this.labels);this.stage.replaceChildren(this.svg);
      this.controls=document.createElement('div');this.controls.className='camera-controls';this.controls.innerHTML='<button type="button" aria-label="Zoom in" title="Zoom in">+</button><button type="button" aria-label="Zoom out" title="Zoom out">−</button><button type="button" aria-label="Fit all bubbles" title="Fit all bubbles">↺</button>';
      const buttons=this.controls.querySelectorAll('button');buttons[0].addEventListener('click',()=>this.zoom(1.45,this.width/2,this.height/2));buttons[1].addEventListener('click',()=>this.zoom(1/1.45,this.width/2,this.height/2));buttons[2].addEventListener('click',()=>this.reset());this.stage.append(this.controls);
      this.trail=document.createElement('nav');this.trail.className='camera-folder-trail';this.trail.setAttribute('aria-label','Folder trail');this.trail.hidden=true;
      this.trailHeading=document.createElement('div');this.trailHeading.className='camera-trail-heading';this.trailHeading.textContent='Folder trail';
      this.trailRows=document.createElement('div');this.trailRows.className='camera-trail-rows';this.trail.append(this.trailHeading,this.trailRows);this.stage.append(this.trail);this.trailKey='';this.trailNodes=[];this.trailEndpoint=null;this.trailFocusNode=null;this.navigationPoint=null;
      this.trail.addEventListener('wheel',event=>{if(event.ctrlKey)return;event.preventDefault();event.stopPropagation();this.trailRows.scrollTop+=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?this.trailRows.clientHeight:1);},{passive:false});
      this.bind();this.lastFrame=performance.now();this.raf=requestAnimationFrame(time=>this.tick(time));
    }
    bind(){
      this.onWheel=event=>{
        if(event.ctrlKey||event.target.closest('.camera-folder-trail'))return;event.preventDefault();event.stopPropagation();this.options.onHover?.(null,event);
        const point=this.point(event),time=this.inputTime(event),gap=time-this.lastWheelTime;
        // A new mouse-wheel notch has no preceding sample. Subsequent trackpad
        // samples use their real interval, including their pixel/line/page units.
        const elapsed=this.lastWheelTime&&gap>0&&gap<160?Math.max(4,gap):16.667;
        const multiplier=event.deltaMode===1?16:event.deltaMode===2?this.height:1,delta=event.deltaY*multiplier;
        this.lastWheelTime=time;this.zoom(Math.exp(-clamp(delta,-400,400)*.0019),point.x,point.y);
        this.applyMotion('wheel',0,delta*1000/elapsed,point.x,point.y,elapsed,time);
      };
      this.onDown=event=>{if(event.button!==0||event.target.closest('.camera-controls,.camera-folder-trail'))return;event.preventDefault();this.options.onHover?.(null,event);const point=this.point(event);this.pointer={id:event.pointerId,startX:point.x,startY:point.y,lastX:point.x,lastY:point.y,lastTime:this.inputTime(event),moved:false};this.stage.setPointerCapture(event.pointerId);};
      this.onMove=event=>{
        if(!this.pointer&&event.target.closest('.camera-controls,.camera-folder-trail')){this.options.onHover?.(null,event);return;}const point=this.point(event);
        if(this.pointer&&this.pointer.id===event.pointerId){
          const time=this.inputTime(event),elapsed=Math.max(4,time-this.pointer.lastTime),distance=Math.hypot(point.x-this.pointer.startX,point.y-this.pointer.startY);
          if(distance>4)this.pointer.moved=true;
          if(this.pointer.moved){const dx=point.x-this.pointer.lastX,dy=point.y-this.pointer.lastY;this.camera.targetX+=dx;this.camera.targetY+=dy;this.hasInteracted=true;this.trailFocusNode=null;this.navigationPoint={x:this.width/2,y:this.height/2};this.lastInput=performance.now();this.applyMotion('pan',dx*1000/elapsed,dy*1000/elapsed,point.x,point.y,elapsed,time);this.stage.classList.add('is-panning');this.options.onHover?.(null,event);}
          this.pointer.lastX=point.x;this.pointer.lastY=point.y;this.pointer.lastTime=time;return;
        }
        const hit=this.hit(point.x,point.y);this.activeHover=hit;this.options.onHover?.(hit?hit.item:null,event);this.svg.style.cursor=hit?'pointer':'grab';
      };
      this.onUp=event=>{if(!this.pointer||this.pointer.id!==event.pointerId)return;const pointer=this.pointer;this.pointer=null;this.stage.classList.remove('is-panning');if(this.stage.hasPointerCapture(event.pointerId))this.stage.releasePointerCapture(event.pointerId);if(!pointer.moved){const point=this.point(event),node=this.hit(point.x,point.y);if(event.shiftKey){if(node)this.options.onSelect?.(node.item,node.context,event);return;}this.options.onSelect?.(null,node?.context||this.context,event);if(node){if(this.focusNode===node&&node.item.kind==='file')this.options.onActivate?.(node.item,node.context);else this.focus(node);}}};
      this.onCancel=()=>{this.pointer=null;this.stage.classList.remove('is-panning');};
      this.onLeave=event=>{if(!this.pointer){this.activeHover=null;this.options.onHover?.(null,event);}};
      this.stage.addEventListener('wheel',this.onWheel,{passive:false});this.stage.addEventListener('pointerdown',this.onDown);this.stage.addEventListener('pointermove',this.onMove);this.stage.addEventListener('pointerup',this.onUp);this.stage.addEventListener('pointercancel',this.onCancel);this.stage.addEventListener('pointerleave',this.onLeave);
    }
    point(event){const bounds=this.stage.getBoundingClientRect();return{x:event.clientX-bounds.left,y:event.clientY-bounds.top};}
    inputTime(event){return Number.isFinite(event.timeStamp)&&event.timeStamp>0?event.timeStamp:performance.now();}
    resize(){const width=Math.max(1,this.stage.clientWidth),height=Math.max(1,this.stage.clientHeight);if(width===this.width&&height===this.height)return;this.camera.x+=(width-this.width)/2;this.camera.targetX+=(width-this.width)/2;this.camera.y+=(height-this.height)/2;this.camera.targetY+=(height-this.height)/2;if(this.navigationPoint){this.navigationPoint.x+=(width-this.width)/2;this.navigationPoint.y+=(height-this.height)/2;}this.width=width;this.height=height;this.svg.setAttribute('viewBox',`0 0 ${width} ${height}`);}
    setScene(items,context,key,reset=false){
      this.resize();if(key===this.sceneKey&&!reset){this.context=context;return;}
      this.sceneKey=key;this.context=context;this.nodes=[];this.roots=[];this.pending=[];this.focusNode=null;this.focusCandidate=null;this.hasInteracted=false;this.trailFocusNode=null;this.trailEndpoint=null;this.trailNodes=[];this.trailKey='';this.trail.hidden=true;this.trailRows.replaceChildren();this.navigationPoint=null;this.world.replaceChildren();this.labels.replaceChildren();this.defs.replaceChildren();this.worldWidth=this.width;this.worldHeight=this.height;
      this.detailFocusPath.clear();this.detailFocusDimension=0;this.lastWheelTime=0;this.inputImpulse=null;
      const layout=window.StorageAtlasBubbleLayout(items,Math.max(1,this.worldWidth-24),Math.max(1,this.worldHeight-24));
      layout.forEach((entry,index)=>{const node=this.makeNode(entry.item,null,context,index);node.targetX=entry.cx+12;node.targetY=entry.cy+12;node.x=node.targetX;node.y=node.targetY;node.radius=entry.radius;this.roots.push(node);});
      this.camera={x:0,y:0,scale:1,targetX:0,targetY:0,targetScale:1};this.svg.setAttribute('aria-label',(context.title||'Storage')+' interactive storage bubbles');this.frame++;
    }
    makeNode(item,parent,context,index){
      const id='atlas-node-'+(++this.serial);const color=this.options.color(item,index,context);const seed=hash((item.path||item.name)+'|'+(context.category||''));
      const node={id,item,parent,context,depth:parent?parent.depth+1:0,color,seed,x:0,y:0,targetX:0,targetY:0,radius:0,offsetX:0,offsetY:0,velocityX:0,velocityY:0,wobble:0,wobbleVelocity:0,shapeScaleX:1,shapeScaleY:1,shapeAngle:0,visualDetail:0,reveal:parent?0:1,children:[],loadState:'idle',visible:false,interactive:false,born:performance.now()};
      const folder=item.kind==='folder'||item.kind==='game'||item.kind==='drive';node.design=folder?'Folder':item.category||item.categoryName||'Other';
      node.group=el('g',{class:'bubble-node '+(folder?'folder-node':'file-node')+' category-'+node.design.toLowerCase(),'data-design':node.design,'data-node-id':id,'data-path':item.path||'',role:'button',tabindex:'-1','aria-pressed':'false','aria-label':item.name+', '+this.options.formatBytes(item.size)});node.backdrop=el('rect',{class:'bubble-viewport-fill',x:0,y:0,fill:shade(color,.46),'pointer-events':'none'});node.circle=el('circle',{class:'bubble-outer',cx:0,cy:0,r:0,fill:shade(color,.46),stroke:color,'stroke-width':folder?1:1.2,'stroke-opacity':'.5','vector-effect':'non-scaling-stroke','pointer-events':'none'});node.rim=el('circle',{class:'bubble-rim',cx:0,cy:0,r:0,fill:'none',stroke:color,'stroke-width':folder?.8:.6,'stroke-opacity':folder?.16:.30,'vector-effect':'non-scaling-stroke','pointer-events':'none'});if(!folder)node.rim.setAttribute('stroke-dasharray',node.design==='Videos'?'3 5':node.design==='Code'?'1 4':node.design==='Archives'?'2 3':'none');node.clipFill=el('path',{class:'bubble-clipped-fill',fill:shade(color,.46),'pointer-events':'none'});node.clipEdge=el('path',{class:'bubble-clipped-edge',fill:'none',stroke:color,'pointer-events':'none'});node.clipRim=el('path',{class:'bubble-clipped-rim',fill:'none',stroke:color,'stroke-width':folder?.8:.6,'stroke-opacity':folder?.16:.30,'pointer-events':'none'});node.clipRim.setAttribute('stroke-dasharray',node.rim.getAttribute('stroke-dasharray')||'none');node.group.append(node.backdrop,node.clipFill,node.circle,node.clipEdge,node.rim,node.clipRim);this.world.append(node.group);
      node.label=el('g',{class:'bubble-label','data-node-id':id});node.glyph=el('g',{class:'bubble-glyph','data-design':node.design,fill:'none',stroke:'#eee8ff','stroke-width':1.5,'stroke-linecap':'round','stroke-linejoin':'round'});node.glyph.innerHTML=glyphs[node.design]||glyphs.Other;node.title=el('text',{class:'bubble-title','text-anchor':'middle'});node.sizeLabel=el('text',{class:'bubble-size','text-anchor':'middle'});node.kindLabel=el('text',{class:'bubble-kind','text-anchor':'middle'});node.check=el('g',{class:'bubble-selection-check'});node.check.append(el('circle',{cx:0,cy:0,r:7,fill:'#e2d5ff'}),el('path',{d:'m-3 0 2 2 4-4',stroke:'#41304f','stroke-width':1.6,fill:'none','stroke-linecap':'round','stroke-linejoin':'round'}));node.label.append(node.glyph,node.title,node.sizeLabel,node.kindLabel);this.labels.append(node.label,node.check);
      node.group.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();if(event.shiftKey)this.options.onSelect?.(node.item,node.context,event);else{this.options.onSelect?.(null,node.context,event);this.focus(node);}}else if(event.key==='Escape'||event.key==='Backspace'){event.preventDefault();event.stopPropagation();if(node.parent)this.focus(node.parent);else this.reset();}});
      this.nodes.push(node);return node;
    }
    expandable(node){return node.item.kind==='folder'||node.item.kind==='game'||node.item.kind==='category'||node.item.kind==='extension'||node.item._other;}
    requestChildren(node){
      if(!this.expandable(node)||node.loadState!=='idle')return;node.loadState='queued';this.pending.push(node);this.pump();
    }
    pump(){
      while(this.inFlight<2&&this.pending.length){const node=this.pending.shift();if(!this.nodes.includes(node))continue;node.loadState='loading';this.inFlight++;const sceneKey=this.sceneKey;Promise.resolve(this.options.fetchChildren(node.item,node.context)).then(data=>{if(sceneKey!==this.sceneKey||!this.nodes.includes(node))return;node.loadState='loaded';if(!data)return;node.childData=data;const items=this.options.coalesce(data.children||[],data.totalBytes??data.childrenSizeTotal??node.item.size);const other=items.find(item=>item._other);if(other)other.omittedCount=Math.max(0,(data.totalChildren||data.children?.length||0)-other.omittedStart);const childContext={...node.context,...data.context,sourceItems:data.children||[],totalRows:data.totalChildren||data.children?.length||0,totalBytes:data.totalBytes??data.childrenSizeTotal??node.item.size};const diameter=node.radius*1.65;const layout=window.StorageAtlasBubbleLayout(items,diameter,diameter,{circular:true});layout.forEach((entry,index)=>{const child=this.makeNode(entry.item,node,childContext,index);child.targetX=entry.cx-diameter/2;child.targetY=entry.cy-diameter/2;child.x=child.targetX;child.y=child.targetY;child.radius=entry.radius;node.children.push(child);});}).catch(error=>{if(sceneKey===this.sceneKey&&this.nodes.includes(node)){node.loadState='error';node.loadError=error.message;}}).finally(()=>{this.inFlight--;this.pump();});}
    }
    zoom(factor,anchorX=this.width/2,anchorY=this.height/2){
      const c=this.camera,worldX=(anchorX-c.targetX)/c.targetScale,worldY=(anchorY-c.targetY)/c.targetScale;c.targetScale=clamp(c.targetScale*factor,.16,1000000);c.targetX=anchorX-worldX*c.targetScale;c.targetY=anchorY-worldY*c.targetScale;this.hasInteracted=true;this.trailFocusNode=null;this.navigationPoint={x:anchorX,y:anchorY};this.lastInput=performance.now();
    }
    worldPosition(node,settled=false){
      const parent=node.parent?this.worldPosition(node.parent,settled):{x:0,y:0};const radius=node.radius*this.camera.scale;
      const motionScale=Math.min(1,140/Math.max(1,radius))*Math.min(1,Math.min(this.width,this.height)*.9/Math.max(1,radius));
      const inset=node.parent?node.parent.radius*.075*(settled?1:node.parent.visualDetail):0;
      return {x:parent.x+node.x+node.offsetX*motionScale,y:parent.y+node.y+inset+node.offsetY*motionScale};
    }
    focus(node){
      if(!node||!this.nodes.includes(node)||!Number.isFinite(node.radius)||node.radius<=0)return;const position=this.worldPosition(node,true);if(!Number.isFinite(position.x)||!Number.isFinite(position.y))return;this.options.onHover?.(null);this.focusNode=node;this.trailFocusNode=node;this.navigationPoint={x:this.width/2,y:this.height/2};const scale=clamp(Math.min(this.width,this.height)*.43/node.radius,.16,1000000);this.camera.targetScale=scale;this.camera.targetX=this.width/2-position.x*scale;this.camera.targetY=this.height/2-position.y*scale;this.hasInteracted=true;this.lastInput=performance.now();this.requestChildren(node);this.options.onFocus?.(node.item,node.context,node);this.kick(3,-3);
      this.detailFocusPath.clear();for(let ancestor=node;ancestor;ancestor=ancestor.parent)this.detailFocusPath.add(ancestor);this.detailFocusDimension=Math.min(this.width,this.height);
    }
    find(item,context){return this.nodes.find(node=>(item.path?String(node.item.path||'').toLowerCase()===String(item.path).toLowerCase()&&!node.item._other:node.item.name===item.name&&node.item.kind===item.kind)&&(!context||(!Object.prototype.hasOwnProperty.call(context,'category')||String(node.context.category||'')===String(context.category||''))&&(!Object.prototype.hasOwnProperty.call(context,'extension')||String(node.context.extension||'')===String(context.extension||''))));}
    setSelection(paths){this.selectedPaths=new Set((paths||[]).map(path=>String(path).toLowerCase()));}
    focusItem(item,context){const node=this.find(item,context);if(!node)return false;this.focus(node);return true;}
    reset(){const scale=clamp(Math.min(this.width/this.worldWidth,this.height/this.worldHeight),.16,1000000);this.camera.targetScale=scale;this.camera.targetX=(this.width-this.worldWidth*scale)/2;this.camera.targetY=(this.height-this.worldHeight*scale)/2;this.focusNode=null;this.focusCandidate=null;this.hasInteracted=false;this.trailFocusNode=null;this.trailEndpoint=null;this.navigationPoint=null;this.detailFocusPath.clear();this.detailFocusDimension=0;this.lastInput=performance.now();this.options.onFocus?.(null,this.context,null);}
    contentsDetail(node){
      const anchored=this.detailFocusPath.has(node),span=anchored?this.detailFocusDimension:Math.min(this.width,this.height),start=anchored?.22:.44;
      return smooth((node.screenRadius-span*start)/(span*.18));
    }
    enclosesViewport(node,factor=1,clearance=0){
      // An ellipse is convex: containing all four corners means its visible
      // fill is exactly the viewport rectangle, with no outer edge to draw.
      const radius=node.screenRadius*factor-clearance/Math.min(node.shapeScaleX,node.shapeScaleY);if(!(radius>0))return false;
      const angle=-node.shapeAngle*Math.PI/180,cosine=Math.cos(angle),sine=Math.sin(angle);
      return [[0,0],[this.width,0],[0,this.height],[this.width,this.height]].every(([x,y])=>{
        const dx=x-node.screenX,dy=y-node.screenY;
        const ex=(dx*cosine-dy*sine)/(radius*node.shapeScaleX),ey=(dx*sine+dy*cosine)/(radius*node.shapeScaleY);
        return ex*ex+ey*ey<1-1e-9;
      });
    }
    clippedEllipse(node,factor=1){
      // Very large SVG transforms lose precision in both Firefox and Chrome.
      // Intersect the ellipse with a padded viewport in double precision and
      // tessellate only its visible arcs, to at most a tenth of a screen pixel.
      const pad=4,left=-pad,top=-pad,right=this.width+pad,bottom=this.height+pad;
      const radius=node.screenRadius*factor,angle=node.shapeAngle*Math.PI/180,cosine=Math.cos(angle),sine=Math.sin(angle);
      const ax=radius*node.shapeScaleX*cosine,bx=-radius*node.shapeScaleY*sine,ay=radius*node.shapeScaleX*sine,by=radius*node.shapeScaleY*cosine,tau=Math.PI*2;
      const point=t=>({x:node.screenX+ax*Math.cos(t)+bx*Math.sin(t),y:node.screenY+ay*Math.cos(t)+by*Math.sin(t)});
      const inside=point=>point.x>=left-1e-5&&point.x<=right+1e-5&&point.y>=top-1e-5&&point.y<=bottom+1e-5;
      const angles=[0,tau],addIntersections=(a,b,center,edges)=>{
        const extent=Math.hypot(a,b),phase=Math.atan2(b,a);if(!(extent>0))return;
        for(const edge of edges){const ratio=(edge-center)/extent;if(ratio<-1||ratio>1)continue;const delta=Math.acos(clamp(ratio,-1,1));for(const value of [phase-delta,phase+delta])angles.push((value%tau+tau)%tau);}
      };
      addIntersections(ax,bx,node.screenX,[left,right]);addIntersections(ay,by,node.screenY,[top,bottom]);angles.sort((a,b)=>a-b);
      const cuts=angles.filter((value,index)=>!index||value-angles[index-1]>1e-12),vertices=[],arcs=[];
      const refine=(a,b,pa,pb,output,depth=0)=>{
        const mid=(a+b)/2,pm=point(mid),dx=pb.x-pa.x,dy=pb.y-pa.y,length=dx*dx+dy*dy;
        const t=length?clamp(((pm.x-pa.x)*dx+(pm.y-pa.y)*dy)/length,0,1):0;
        const error=Math.hypot(pm.x-pa.x-t*dx,pm.y-pa.y-t*dy);
        if(error>.10&&depth<18){refine(a,mid,pa,pm,output,depth+1);refine(mid,b,pm,pb,output,depth+1);}else output.push(pb);
      };
      for(let index=1;index<cuts.length;index++){
        const a=cuts[index-1],b=cuts[index];if(b-a<1e-12||!inside(point((a+b)/2)))continue;
        const pa=point(a),pb=point(b),arc=[pa];refine(a,b,pa,pb,arc);arcs.push(arc);vertices.push(...arc);
      }
      for(const [x,y] of [[left,top],[right,top],[right,bottom],[left,bottom]]){
        const dx=x-node.screenX,dy=y-node.screenY,ex=(dx*cosine+dy*sine)/(radius*node.shapeScaleX),ey=(-dx*sine+dy*cosine)/(radius*node.shapeScaleY);
        if(ex*ex+ey*ey<=1)vertices.push({x,y});
      }
      const unique=[...new Map(vertices.map(point=>[point.x.toFixed(4)+'|'+point.y.toFixed(4),point])).values()];
      if(unique.length){const center=unique.reduce((sum,p)=>({x:sum.x+p.x/unique.length,y:sum.y+p.y/unique.length}),{x:0,y:0});unique.sort((a,b)=>Math.atan2(a.y-center.y,a.x-center.x)-Math.atan2(b.y-center.y,b.x-center.x));}
      const coords=point=>point.x.toFixed(4)+' '+point.y.toFixed(4);
      return {fill:unique.length>=3?'M'+unique.map(coords).join(' L')+' Z':'',edge:arcs.map(arc=>'M'+arc.map(coords).join(' L')).join(' ')};
    }
    kick(dx,dy,anchorX=this.width/2,anchorY=this.height/2){this.applyMotion('focus',dx*60,dy*60,anchorX,anchorY,16.667,performance.now());}
    applyMotion(kind,velocityX,velocityY,anchorX,anchorY,elapsed,time){
      const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches,speed=Math.hypot(velocityX,velocityY);
      // The response is driven by speed, in screen pixels/second. Replacing part
      // of the previous drive prevents event frequency from piling up impulses.
      const strength=reduced?0:1-Math.exp(-Math.min(speed,12000)/1050),span=Math.min(this.width,this.height),sign=kind==='wheel'?-Math.sign(velocityY):0;
      this.inputImpulse={kind,time,elapsed,velocityX,velocityY,speed,strength,anchorX,anchorY,sign};
      if(reduced||!speed)return;
      for(const node of this.nodes){
        if(!node.visible)continue;const peers=node.parent?node.parent.children:this.roots;const largest=Math.max(...peers.map(peer=>peer.radius),node.radius,1e-9);const fraction=node.radius/largest;
        const phase=node.seed%628/100,falloff=.22+.78*Math.exp(-Math.hypot(node.screenX-anchorX,node.screenY-anchorY)/(span*.8));
        let directionX=velocityX/speed,directionY=velocityY/speed;
        if(kind==='wheel'){const dx=node.screenX-anchorX,dy=node.screenY-anchorY,length=Math.hypot(dx,dy);directionX=length>1e-6?dx/length*sign:0;directionY=length>1e-6?dy/length*sign:0;}
        const variation=Math.sin(phase*1.7)*.14,response=(1.5-fraction*.75)*falloff;
        const impulse=node.radius*.026*strength*response*(.9+.1*Math.sin(phase));
        node.inputImpulseX=(directionX-directionY*variation)*impulse;node.inputImpulseY=(directionY+directionX*variation)*impulse;node.inputForce=strength;node.inputAt=time;
        node.velocityX=node.velocityX*.45+node.inputImpulseX;node.velocityY=node.velocityY*.45+node.inputImpulseY;
        node.wobbleVelocity=node.wobbleVelocity*.45+Math.sin(phase)*.0055*strength*response;
      }
    }
    animateNodes(time,dt,reduced){
      const groups=new Map();
      for(const node of this.nodes){const key=node.parent||this;let peers=groups.get(key);if(!peers){peers=[];groups.set(key,peers);}peers.push(node);}
      for(const peers of groups.values()){
        const largest=Math.max(...peers.map(node=>node.radius),1e-9);
        for(const node of peers){
          const fraction=node.radius/largest;node.mass=Math.max(.05,fraction*fraction);node.springRate=.06+.10*(1-fraction);
          if(reduced){node.offsetX=node.offsetY=node.velocityX=node.velocityY=node.wobble=node.wobbleVelocity=0;continue;}
          const phase=node.seed%628/100;
          // Every item has its own phase; heavier bubbles take longer to settle.
          const sway=node.radius*.010;const frequency=2200+fraction*2200;
          // Seeded, smooth variations give every bubble its own changing drift.
          const homeX=(.72*Math.sin(time/frequency+phase)+.28*Math.sin(time/(frequency*.47)+phase*2.7))*sway;
          const homeY=(.72*Math.cos(time/(frequency*1.23)+phase*1.7)+.28*Math.sin(time/(frequency*.63)+phase*3.1))*sway;
          node.velocityX+=(homeX-node.offsetX)*node.springRate*dt;node.velocityY+=(homeY-node.offsetY)*node.springRate*dt;
        }
        if(!reduced)for(let i=0;i<peers.length;i++)for(let j=i+1;j<peers.length;j++){
          const a=peers[i],b=peers[j],restDistance=Math.hypot(a.x-b.x,a.y-b.y),reach=(a.radius+b.radius)*1.7;
          if(restDistance>reach)continue;
          // Neighbor springs transmit displacement, weighted by relative mass.
          const link=.032*(1-restDistance/(reach*1.5))*dt,totalMass=a.mass+b.mass;
          const fx=(b.offsetX-a.offsetX)*link,fy=(b.offsetY-a.offsetY)*link;
          a.velocityX+=fx*b.mass/totalMass;a.velocityY+=fy*b.mass/totalMass;
          b.velocityX-=fx*a.mass/totalMass;b.velocityY-=fy*a.mass/totalMass;
        }
        for(const node of peers){
          const damping=.79+.05*Math.sqrt(node.mass);node.velocityX*=Math.pow(damping,dt);node.velocityY*=Math.pow(damping,dt);
          node.offsetX+=node.velocityX*dt;node.offsetY+=node.velocityY*dt;
          const max=node.radius*.033,length=Math.hypot(node.offsetX,node.offsetY);
          if(length>max&&length>0){node.offsetX*=max/length;node.offsetY*=max/length;node.velocityX*=.55;node.velocityY*=.55;}
          node.wobbleVelocity+=-node.wobble*(.11+.08*(1-Math.sqrt(node.mass)))*dt;node.wobbleVelocity*=Math.pow(.77,dt);node.wobble=clamp(node.wobble+node.wobbleVelocity*dt,-.014,.014);
          node.shapeScaleX=reduced?1:1+node.wobble;node.shapeScaleY=1/node.shapeScaleX;
          node.shapeAngle=Math.atan2(node.velocityY,node.velocityX)*180/Math.PI;
        }
      }
    }
    hit(x,y){
      const c=this.camera,worldX=(x-c.x)/c.scale,worldY=(y-c.y)/c.scale;let best=null;
      for(const node of this.nodes){if(!node.interactive)continue;const dx=worldX-node.worldX,dy=worldY-node.worldY,angle=-node.shapeAngle*Math.PI/180;const ex=(dx*Math.cos(angle)-dy*Math.sin(angle))/(node.radius*node.shapeScaleX),ey=(dx*Math.sin(angle)+dy*Math.cos(angle))/(node.radius*node.shapeScaleY);if(ex*ex+ey*ey<=1&&(!best||node.depth>best.depth))best=node;}return best;
    }
    measure(text,size=12,weight=600){
      const key=weight+'|'+size+'|'+text;if(this.textWidthCache.has(key))return this.textWidthCache.get(key);
      this.textMeasure.font=`${weight} ${size}px "Segoe UI Variable", "Segoe UI", Arial, sans-serif`;const width=this.textMeasure.measureText(text).width;
      if(this.textWidthCache.size>5000)this.textWidthCache.clear();this.textWidthCache.set(key,width);return width;
    }
    fitText(text,width,size){
      if(this.measure(text,size)<=width)return text;let low=0,high=text.length;
      while(low<high){const mid=Math.ceil((low+high)/2);if(this.measure(text.slice(0,mid)+'…',size)<=width)low=mid;else high=mid-1;}
      return text.slice(0,low)+'…';
    }
    folderNode(node){return node&&['folder','game','drive'].includes(node.item.kind)&&!node.item._other;}
    chainChild(node){
      if(!this.folderNode(node)||!node.children.length||!(node.item.size>0))return null;
      return node.children.find(child=>this.folderNode(child)&&child.item.size/node.item.size>=.90)||null;
    }
    updateTrail(){
      const span=Math.min(this.width,this.height),point=this.navigationPoint||{x:this.width/2,y:this.height/2};
      this.trail.style.setProperty('--trail-max-height',Math.max(58,Math.min(174,this.height*.43))+'px');
      const contains=node=>Math.hypot(node.screenX-point.x,node.screenY-point.y)<node.screenRadius*.78;
      let endpoint=null;
      // Fullscreen pauses automatic focus detection while preserving the map.
      // Keep its existing trail too; a new gesture resumes geometric tracking.
      if(!this.hasInteracted)endpoint=this.trailEndpoint;
      else{
        if(this.trailFocusNode&&this.nodes.includes(this.trailFocusNode))endpoint=this.trailFocusNode;
        else{
          endpoint=this.nodes.filter(node=>this.folderNode(node)&&node.interactive&&node.reveal>=.56&&node.screenRadius>=span*.32&&contains(node)).sort((a,b)=>b.depth-a.depth)[0]||null;
          // Different enter/leave scales prevent the path toggling at a boundary.
          const previous=this.trailEndpoint;
          if(previous&&previous.interactive&&previous.reveal>=.45&&previous.screenRadius>=span*.26&&contains(previous)&&(!endpoint||previous.depth>endpoint.depth))endpoint=previous;
        }
      }
      const path=[];for(let node=endpoint;node;node=node.parent)if(this.folderNode(node))path.unshift(node);
      const chain=path.some((node,index)=>index>0&&this.chainChild(path[index-1])===node)||!!this.chainChild(endpoint);
      this.trailEndpoint=endpoint;this.trailNodes=chain?path:[];this.trail.hidden=!this.trailNodes.length;
      const key=this.trailNodes.map(node=>node.id).join('|');
      if(key!==this.trailKey){
        this.trailKey=key;const active=document.activeElement?.dataset?.trailNodeId;
        this.trailRows.replaceChildren(...this.trailNodes.map((node,index)=>{
          const button=document.createElement('button');button.type='button';button.className='camera-trail-row';button.dataset.trailNodeId=node.id;button.dataset.path=node.item.path||'';
          const name=String(node.item.displayName||node.item.name);button.title=node.item.path||name;button.setAttribute('aria-label','Focus '+name);if(index===this.trailNodes.length-1)button.setAttribute('aria-current','location');
          const mark=document.createElement('span');mark.className='camera-trail-mark';mark.textContent=index?'↳':'⌂';mark.setAttribute('aria-hidden','true');
          const text=document.createElement('span');text.className='camera-trail-name';text.textContent=name;button.append(mark,text);button.addEventListener('click',event=>{if(event.shiftKey)this.options.onSelect?.(node.item,node.context,event);else{this.options.onSelect?.(null,node.context,event);this.focus(node);}});return button;
        }));
        if(active)this.trailRows.querySelector('[data-trail-node-id="'+active+'"]')?.focus({preventScroll:true});
        this.trailRows.scrollTop=this.trailRows.scrollHeight;
      }
      if(this.trail.hidden){this.trailBox=null;return;}
      const box=this.trail.getBoundingClientRect(),stage=this.stage.getBoundingClientRect();this.trailBox={x:box.left-stage.left,y:box.top-stage.top,width:box.width,height:box.height};
    }
    labelPlan(node,detail,time){
      // A folder keeps its name until readable detail is ready. Once accepted,
      // its name gets a short reading window, even in concentric folder chains.
      const retained=node.labelVisible&&time-(node.labelSince||0)<350;
      if(!node.visible||node.screenRadius<27||node.reveal<(node.labelVisible?.45:.60))return null;
      // Descendants retire the parent only when their accepted label actually
      // occupies its space. Circle detail alone must never erase an identity.
      const radius=node.screenRadius,font=radius>105?14:radius>55?12:10,lift=node.visualDetail;
      const halfHeight=font+8+(radius>75?(font+4)/2:0),innerRadius=radius*Math.min(node.shapeScaleX,node.shapeScaleY);
      const headerDistance=Math.max(0,Math.min(innerRadius*.76,innerRadius-halfHeight-10))*lift;
      const chordEdge=Math.min(innerRadius,headerDistance+halfHeight*lift),chord=2*Math.sqrt(Math.max(0,innerRadius*innerRadius-chordEdge*chordEdge));
      const width=Math.max(1,Math.min(290,radius*1.43,chord-12)),labelY=node.screenY-headerDistance;node.labelY=labelY;
      const name=String(node.item.displayName||node.item.name);let lines=[];
      if(radius>75&&this.measure(name,font)>width&&name.includes(' ')){
        const words=name.split(/\s+/);let first='';
        while(words.length&&this.measure((first+' '+words[0]).trim(),font)<=width)first=(first+' '+words.shift()).trim();
        if(first&&words.length)lines=[first,this.fitText(words.join(' '),width,font)];
      }
      if(!lines.length)lines=[this.fitText(name,width,font)];
      const lineHeight=font+4,top=labelY-8-(lines.length-1)*lineHeight/2,sizeY=top+lines.length*lineHeight+3;
      const sizeText=this.options.formatBytes(node.item.size),kind=lift<.25&&radius>110&&lines.length===1?(node.item._other?(node.item.omittedCount||'')+' smaller items':node.item.kind==='folder'?(node.item.fileCount||0).toLocaleString()+' files':node.item.kind==='game'?node.item.source||'Game installation':''):'';
      const glyph=radius>43&&lift<.35,glyphScale=radius>90?.8:.62;
      const boxWidth=Math.max(...lines.map(line=>this.measure(line,font)),this.measure(sizeText,11,450),kind?this.measure(kind,9,400):0,glyph?24*glyphScale:0);
      return {node,lines,font,lineHeight,top,sizeY,sizeText,kind,glyph,glyphScale,x:node.screenX-boxWidth/2-5,y:glyph?top-30:top-font-3,width:boxWidth+10,height:(kind?sizeY+20:sizeY+5)-(glyph?top-30:top-font-3),priority:node.depth*1000+Math.min(radius,400)+(node.selected?10000:0)+(retained?30000:0)};
    }
    layoutLabels(plans,time){
      const placed=[],obstacles=this.trailBox?[this.trailBox]:[];plans.sort((a,b)=>b.priority-a.priority);
      for(const plan of plans){
        const node=plan.node;const inside=plan.x>=3&&plan.y>=3&&plan.x+plan.width<=this.width-3&&plan.y+plan.height<=this.height-3;
        const overlap=placed.concat(obstacles).some(box=>plan.x<box.x+box.width+4&&plan.x+plan.width+4>box.x&&plan.y<box.y+box.height+4&&plan.y+plan.height+4>box.y);
        const previouslyVisible=node.labelVisible;
        node.labelVisible=inside&&!overlap;node.label.style.display=node.labelVisible?'':'none';node.label.setAttribute('aria-hidden',String(!node.labelVisible));if(!node.labelVisible)continue;
        if(!previouslyVisible)node.labelSince=time;placed.push(plan);node.label.setAttribute('opacity','1');
        const textKey=plan.font+'|'+plan.lines.join('|');if(node.textKey!==textKey){node.title.replaceChildren(...plan.lines.map(line=>el('tspan',{},line)));node.textKey=textKey;}
        node.title.setAttribute('font-size',String(plan.font));[...node.title.children].forEach((span,index)=>{span.setAttribute('x',String(node.screenX));span.setAttribute('y',String(plan.top+index*plan.lineHeight));});
        node.sizeLabel.textContent=plan.sizeText;node.sizeLabel.setAttribute('x',String(node.screenX));node.sizeLabel.setAttribute('y',String(plan.sizeY));
        node.kindLabel.textContent=plan.kind;node.kindLabel.setAttribute('x',String(node.screenX));node.kindLabel.setAttribute('y',String(plan.sizeY+17));
        node.glyph.style.display=plan.glyph?'':'none';node.glyph.setAttribute('transform',`translate(${node.screenX-12*plan.glyphScale} ${plan.top-30}) scale(${plan.glyphScale})`);node.glyph.setAttribute('opacity',node.design==='Folder'?'.48':'.7');
      }
      this.labelBoxes=placed.map(box=>({id:box.node.id,x:box.x,y:box.y,width:box.width,height:box.height}));
    }
    tick(time){
      if(!this.alive)return;const dt=clamp((time-this.lastFrame)/16.667,.25,2);this.lastFrame=time;const c=this.camera;const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;const ease=reduced?1:1-Math.pow(.81,dt);c.x+=(c.targetX-c.x)*ease;c.y+=(c.targetY-c.y)*ease;c.scale+=(c.targetScale-c.scale)*ease;this.world.removeAttribute('transform');
      this.animateNodes(time,dt,reduced);const labelPlans=[];
      for(const node of this.nodes){
        // Cap motion in screen units. Ancestors recede gently as the camera
        // dives through them, rather than magnifying every inherited wobble.
        node.screenRadius=node.radius*c.scale;const ancestorFade=Math.min(1,Math.min(this.width,this.height)*.9/Math.max(1,node.screenRadius)),motionScale=Math.min(1,140/Math.max(1,node.screenRadius))*ancestorFade;node.motionScale=motionScale;
        node.shapeScaleX=reduced?1:1+node.wobble*Math.min(1,100/Math.max(1,node.screenRadius))*ancestorFade;node.shapeScaleY=1/node.shapeScaleX;
        node.worldX=(node.parent?node.parent.worldX:0)+node.x+node.offsetX*motionScale;node.worldY=(node.parent?node.parent.worldY:0)+node.y+(node.parent?node.parent.radius*.075*node.parent.visualDetail:0)+node.offsetY*motionScale;node.screenX=c.x+node.worldX*c.scale;node.screenY=c.y+node.worldY*c.scale;
        const angle=node.shapeAngle*Math.PI/180,cosine=Math.cos(angle),sine=Math.sin(angle),extentX=node.screenRadius*Math.hypot(node.shapeScaleX*cosine,node.shapeScaleY*sine),extentY=node.screenRadius*Math.hypot(node.shapeScaleX*sine,node.shapeScaleY*cosine);
        const intersects=node.screenX+extentX>0&&node.screenX-extentX<this.width&&node.screenY+extentY>0&&node.screenY-extentY<this.height;
        const detailDimension=Math.min(this.width,this.height);const parentAlpha=node.parent?node.parent.reveal:1;const revealTarget=node.parent?parentAlpha*this.contentsDetail(node.parent):1;node.reveal+=(revealTarget-node.reveal)*(reduced?1:ease);node.visible=intersects&&node.reveal>.025;node.interactive=node.visible&&node.reveal>.42&&node.screenRadius>=2;
        const selected=this.selectedPaths.has(String(node.item.path||'').toLowerCase());node.selected=selected;
        node.group.style.display=node.visible?'':'none';node.label.style.display=node.visible?'':'none';node.group.setAttribute('tabindex',node.interactive&&node.screenRadius>15?'0':'-1');node.group.setAttribute('opacity',String(node.reveal));node.group.setAttribute('data-selected',String(selected));node.group.setAttribute('aria-pressed',String(selected));node.group.classList.toggle('selected',selected);
        // Project geometry before SVG tessellation. Magnifying tiny paths with
        // a huge group scale can turn circles into polygons in Firefox.
        node.circle.setAttribute('r',String(node.screenRadius));const shapeTransform=`translate(${node.screenX} ${node.screenY}) rotate(${node.shapeAngle}) scale(${node.shapeScaleX} ${node.shapeScaleY})`;node.circle.setAttribute('transform',shapeTransform);const rimFactor=node.design==='Folder'?.94:.86;node.rim.setAttribute('r',String(node.screenRadius*rimFactor));node.rim.setAttribute('transform',shapeTransform);
        node.viewportFill=node.visible&&this.enclosesViewport(node,1,2);node.backdrop.style.display=node.viewportFill?'':'none';node.backdrop.setAttribute('width',String(this.width));node.backdrop.setAttribute('height',String(this.height));node.circle.style.display=node.viewportFill?'none':'';node.rim.style.display=node.visible&&this.enclosesViewport(node,rimFactor,1.4)?'none':'';
        const detail=node.children.length?this.contentsDetail(node):0;node.circle.setAttribute('fill-opacity',String(1-detail*.88));node.backdrop.setAttribute('fill-opacity',String(1-detail*.88));node.circle.setAttribute('stroke-opacity',String(selected?1:.42+detail*.20));node.circle.setAttribute('stroke',selected?'#e8dcff':node.color);node.circle.setAttribute('stroke-width',String(selected?2.3:node.design==='Folder'?1:1.2));node.rim.setAttribute('opacity',String(1-detail));
        node.clipFill.style.display=node.clipEdge.style.display=node.clipRim.style.display='none';
        if(node.visible&&node.screenRadius>8192){
          if(!node.viewportFill){const geometry=this.clippedEllipse(node);node.clipFill.setAttribute('d',geometry.fill);node.clipEdge.setAttribute('d',geometry.edge);node.clipFill.setAttribute('fill-opacity',String(1-detail*.88));node.clipEdge.setAttribute('stroke',selected?'#e8dcff':node.color);node.clipEdge.setAttribute('stroke-opacity',String(selected?1:.42+detail*.20));node.clipEdge.setAttribute('stroke-width',String(selected?2.3:node.design==='Folder'?1:1.2));node.clipFill.style.display=node.clipEdge.style.display='';node.circle.style.display='none';}
          if(node.rim.style.display!=='none'&&detail<1){node.clipRim.setAttribute('d',this.clippedEllipse(node,rimFactor).edge);node.clipRim.setAttribute('opacity',String(1-detail));node.clipRim.style.display='';node.rim.style.display='none';}
        }
        node.detail=detail;node.visualDetail+=(detail-node.visualDetail)*(reduced?1:ease);node.check.setAttribute('transform',`translate(${node.screenX+node.screenRadius*.62} ${node.screenY-node.screenRadius*.62})`);node.check.style.display=selected&&node.visible&&node.screenRadius>16?'':'none';
        if(node.visible&&node.screenRadius>=Math.min(70,detailDimension*.22)&&node.depth<24)this.requestChildren(node);
      }
      this.updateTrail();
      for(const node of this.nodes){const plan=this.labelPlan(node,node.detail,time);node.label.style.display='none';if(plan)labelPlans.push(plan);else node.labelVisible=false;}
      this.layoutLabels(labelPlans,time);
      if(this.hasInteracted&&!this.trailFocusNode&&!this.pointer&&time-this.lastInput>250){const centerX=this.width/2,centerY=this.height/2;const candidate=this.nodes.filter(node=>node.interactive&&this.expandable(node)&&node.screenRadius>=Math.min(this.width,this.height)*.38&&Math.hypot(node.screenX-centerX,node.screenY-centerY)<node.screenRadius*.64).sort((a,b)=>b.depth-a.depth)[0]||null;if(candidate!==this.focusCandidate){this.focusCandidate=candidate;this.focusCandidateAt=time;}else if(time-this.focusCandidateAt>350&&candidate!==this.focusNode){this.focusNode=candidate;this.options.onFocus?.(candidate?candidate.item:null,candidate?candidate.context:this.context,candidate);}}
      this.frame++;this.raf=requestAnimationFrame(next=>this.tick(next));
    }
    getState(){const c=this.camera;return{inputImpulse:this.inputImpulse?{...this.inputImpulse}:null,detailAnchor:{path:this.detailFocusPath.values().next().value?.item.path||'',depth:this.detailFocusPath.values().next().value?.depth??-1},folderTrail:{visible:!this.trail.hidden,paths:this.trailNodes.map(node=>node.item.path||'')},camera:{x:c.x,y:c.y,scale:c.scale,targetX:c.targetX,targetY:c.targetY,targetScale:c.targetScale,focusPath:this.focusNode?.item.path||'',focusId:this.focusNode?.id||''},frame:this.frame,labelBoxes:this.labelBoxes||[],sceneKey:this.sceneKey,nodes:this.nodes.map(node=>({id:node.id,path:node.item.path||'',name:node.item.name,kind:node.item.kind,design:node.design,labelVisible:node.labelVisible,selected:!!node.selected,mass:node.mass,motionScale:node.motionScale,springRate:node.springRate,inputImpulseX:node.inputImpulseX||0,inputImpulseY:node.inputImpulseY||0,inputForce:node.inputForce||0,inputAt:node.inputAt||0,offsetX:node.offsetX,offsetY:node.offsetY,velocityX:node.velocityX,velocityY:node.velocityY,parentPath:node.parent?.item.path||'',parentId:node.parent?.id||null,size:node.item.size,worldX:node.worldX,worldY:node.worldY,worldRadius:node.radius,screenCx:node.screenX,screenCy:node.screenY,radius:node.screenRadius,depth:node.depth,visible:node.visible,interactive:node.interactive,opacity:node.reveal,shapeScaleX:node.shapeScaleX,shapeScaleY:node.shapeScaleY,shapeAngle:node.shapeAngle,determinant:node.shapeScaleX*node.shapeScaleY,contentsDetail:node.detail,visualDetail:node.visualDetail,labelY:node.labelY,viewportFill:node.viewportFill,restX:node.x,restY:node.y,loadState:node.loadState}))};}
    destroy(){this.alive=false;cancelAnimationFrame(this.raf);this.stage.removeEventListener('wheel',this.onWheel);this.stage.removeEventListener('pointerdown',this.onDown);this.stage.removeEventListener('pointermove',this.onMove);this.stage.removeEventListener('pointerup',this.onUp);this.stage.removeEventListener('pointercancel',this.onCancel);this.stage.removeEventListener('pointerleave',this.onLeave);this.svg.remove();this.controls.remove();this.trail.remove();}
  }
  window.StorageAtlasBubbleCamera={create:options=>new BubbleCamera(options)};
})();
