import type { MaintenanceGameTexts } from "./messages";

/**
 * „Lauf“, the waiting game of the maintenance page and of the generic error pages: a small robot on one wheel rolls
 * along a road, jumps, slides and changes lanes. It never starts on its own, makes no sound and needs no network.
 *
 * The game is plain browser source, so the gateway can inline it in its self-contained page under a nonce and Cloud
 * pages can load the same text on demand. `LAUF_SCRIPT` is one function expression: `(options) => controller`.
 */
export type MaintenanceGameOptions = {
  /** The element the game's full-size layer is appended to. */
  host: HTMLElement;
  /** The page content above the road; its bottom edge is the horizon. Read on every frame, so it may be replaced. */
  anchor: () => Element | null;
  t: MaintenanceGameTexts;
  /** Whether the page shows its dark theme right now. */
  dark: () => boolean;
  /** The game closed (Escape, „Leave game“); the page returns focus to its entry. */
  onClose: () => void;
  /** After the maintenance ended: the round is over or the player closed the game, so the page may reload. */
  onFinish: () => void;
};

export type MaintenanceGameController = {
  /** Shows the waiting state: the robot faces the viewer, Space or a tap starts. */
  open: () => void;
  /** Opens if needed and starts a round right away (the maintenance symbol). */
  start: () => void;
  close: () => void;
  /**
   * The maintenance ended. Returns true while a round is on screen: the page then shows „Maintenance finished ·
   * Continue“ and waits for `onFinish`. Returns false otherwise, and the game closes.
   */
  end: () => boolean;
  isOpen: () => boolean;
};

export type MaintenanceGameFactory = (options: MaintenanceGameOptions) => MaintenanceGameController;

/** The game's own layer: canvas, live text for screen readers and the „Leave game“ button. Theme comes from the game. */
export const LAUF_CSS = `.lauf{position:fixed;inset:0;z-index:1;background:var(--lauf-bg);font-family:inherit}
.lauf:focus{outline:none}
.lauf canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
[data-lauf=run] .lauf canvas{touch-action:none}
.lauf-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.lauf-exit{position:fixed;left:12px;bottom:12px;z-index:5;font:inherit;font-size:13px;color:var(--lauf-text);background:var(--lauf-chip);border:1px solid var(--lauf-edge);border-radius:8px;height:30px;padding:0 10px;cursor:pointer}
.lauf-exit:hover{background:var(--lauf-hover)}.lauf-exit:focus-visible{outline:2px solid var(--lauf-focus);outline-offset:2px}`;

export const LAUF_SCRIPT = String.raw`(o)=>{
const t=o.t,RM=matchMedia('(prefers-reduced-motion: reduce)').matches,TOUCH=matchMedia('(pointer: coarse)').matches;
const TAU=Math.PI*2,rnd=(a,b)=>a+Math.random()*(b-a),clamp=(v,a,b)=>Math.max(a,Math.min(b,v)),pick=a=>a[Math.random()*a.length|0];
const OR='#ea580c',KEY='k2b-lauf-2',LKEY='k2b-lauf-learn';
const PAL={light:{bg:'255 255 255',ink:'#27272a',grey:'#8a8a94',light:'#d4d4d8',road0:'#f7f7f8',road1:'#eaeaee',streak:'rgb(255 255 255 / .3)',edge:'#fff',rim:'#fdba74',chip:'#fde3d3',bot:'#27272a',shell:'#18181b',wheel:'#3f3f46',panel:'#52525b',text:'#45454e',line:'#d4d4d8',hover:'#f4f4f5',focus:'#3b82f6'},
dark:{bg:'24 24 27',ink:'#e4e4e7',grey:'#9a9aa5',light:'#52525b',road0:'#2a2a2f',road1:'#34343a',streak:'rgb(255 255 255 / .04)',edge:'#3f3f46',rim:'#9a3412',chip:'#43261a',bot:'#52525b',shell:'#3f3f46',wheel:'#71717a',panel:'#a1a1aa',text:'#c4c4cc',line:'#3f3f46',hover:'#222226',focus:'#60a5fa'}};
let C=PAL.light,BG=C.bg,INK=C.ink,GREY=C.grey,LIGHT=C.light,BOT=C.bot,PANEL=C.panel;
const ls=(k,v)=>{try{if(v===undefined)return +localStorage.getItem(k)||0;localStorage.setItem(k,v)}catch{}return v||0};
const fmt=n=>String(n).replace(/\B(?=(\d{3})+(?!\d))/g,' ');
const bgA=a=>'rgb('+BG+' / '+a+')';
const SOLID={low:1,tall:1,bar:1},PICKS=['mag','bat','spring','wind'];
const layer=document.createElement('div');layer.className='lauf';layer.hidden=true;layer.tabIndex=-1;layer.setAttribute('role','group');layer.setAttribute('aria-label',t.name);
layer.innerHTML='<canvas aria-hidden="true"></canvas><span class="lauf-sr" role="status"></span><button type="button" class="lauf-exit"></button>';
o.host.appendChild(layer);
const c=layer.querySelector('canvas'),x=c.getContext('2d'),sr=layer.querySelector('.lauf-sr'),exitB=layer.querySelector('button');exitB.textContent=t.exit;
let FONT='system-ui,sans-serif';
const LW=1.25,TH=.4,CT=Math.cos(TH),ST=Math.sin(TH),CH=3.5,CD=5.2;
const JV=8.2,G_HOLD=20,G_TAP=30,G_DOWN=26,SLIDE=.62;
const V0=RM?10.5:13,VADD=RM?9:13;
const ZC0=CD*CT+CH*ST,A0=(CH*CT-CD*ST)/ZC0;
const cam={w:0,h:0,F:1,cx:0,cy:0,rw:0,py:0,hz:0,S:1,CH,CD};
let st,raf=0,last=0,ended=false,learned=ls(LKEY),pale=1,idleT=0,open=false;
const mode=m=>{if(open)document.documentElement.dataset.lauf=m;else delete document.documentElement.dataset.lauf};
const paint=()=>{C=o.dark()?PAL.dark:PAL.light;BG=C.bg;INK=C.ink;GREY=C.grey;LIGHT=C.light;BOT=C.bot;PANEL=C.panel;FONT=getComputedStyle(layer).fontFamily||FONT;
for(const[k,v]of[['bg','rgb('+C.bg+')'],['text',C.text],['edge',C.line],['chip',bgA(.9)],['hover',C.hover],['focus',C.focus]])layer.style.setProperty('--lauf-'+k,v)};
function fit(){const d=Math.min(2,devicePixelRatio||1);cam.w=c.clientWidth;cam.h=c.clientHeight;c.width=cam.w*d;c.height=cam.h*d;x.setTransform(d,0,0,d,0,0);if(st&&open)draw(0)}
function layout(){const a=o.anchor(),top=layer.getBoundingClientRect().top,bottom=a?a.getBoundingClientRect().bottom-top:0;
cam.rw=Math.min(cam.w*.8,440);cam.cx=cam.w/2;cam.py=cam.h-Math.max(86,cam.h*.13);cam.hz=Math.min(bottom+2,cam.py-230);cam.S=cam.py-cam.hz;
cam.F=cam.S/(ST/CT+A0);const m=3*LW*cam.F/cam.rw/ZC0;cam.CH=CH*m;cam.CD=CD*m;cam.cy=cam.py-A0*cam.F}
new ResizeObserver(fit).observe(c);
function P(wx,wy,z){const dz=z+cam.CD,dy=wy-cam.CH,zc=Math.max(.7,dz*CT-dy*ST),yc=dy*CT+dz*ST,k=cam.F/zc;return{x:cam.cx+(wx-st.px*.35)*k+st.sx,y:cam.cy-yc*k+st.sy,k}}
function reset(m){st={mode:m,t:0,dist:0,pts:0,v:V0,lane:0,px:0,pv:0,y:0,vy:0,hold:false,holdT:0,jbuf:0,sbuf:0,slide:0,lastMove:-9,jumpT:-9,obs:[],next:56,sec:{kind:'intro',left:8,i:0},secN:0,combo:0,comboT:0,wind:0,mag:0,spr:0,inv:0,lives:0,pickAt:300,pickN:0,picks:{},best0:ls(KEY),recT:0,ot:0,run:0,shake:0,flash:0,sx:0,sy:0,P:[],pops:[],toast:null,coins:0,near:0,hits:0,scare:0,aa:0,av:0}}

/* course: sections with a rhythm instead of pure chance */
const lvl=()=>st.dist<250?0:st.dist<520?1:st.dist<900?2:3;
const add=(d,type,lane,q={})=>st.obs.push(Object.assign({d,x:(lane-1)*LW,w:LW*.84,type,y:.5},q));
const coins=(d,lane,n,arc)=>{for(let i=0;i<n;i++)add(d+(i-(arc?(n-1)/2:0))*1.7,'coin',lane,{y:arc?.55+Math.sin(Math.PI*i/(n-1))*1.0:.5})};
const others=l=>[0,1,2].filter(i=>i!==l);
function row(d,pat){const l=Math.random()*3|0,[a,b]=others(l);
switch(pat){
case'coins':coins(d,l,5);break;
case'low':add(d,'low',l);coins(d,l,5,true);break;
case'lowC':add(d,'low',1);coins(d,1,5,true);break;
case'tall':add(d,'tall',l);coins(d-3,pick([a,b]),4);break;
case'tallC':add(d,'tall',1);coins(d-3,pick([0,2]),4);break;
case'bar':add(d,'bar',l);coins(d-2,l,4);break;
case'barC':add(d,'bar',1);coins(d-2,1,4);break;
case'tall2':add(d,'tall',a);add(d,'tall',b);coins(d-4,l,4);break;
case'wide':{const s2=Math.random()<.5?0:1;add(d,'low',0,{x:(s2-.5)*LW,w:LW*1.84});add(d,'tall',s2?0:2);break}
case'lows3':[0,1,2].forEach(i=>add(d,'low',i));coins(d,l,5,true);break;
case'bars3':[0,1,2].forEach(i=>add(d,'bar',i));coins(d-2,l,4);break;
case'mix3':add(d,'tall',l);add(d,'low',a);add(d,'bar',b);break;
case'moving':add(d,'low',0,{mv:1,x0:(pick([0,1])-.5)*LW,ph:rnd(0,TAU)});break;
case'combo':[0,1,2].forEach(i=>add(d,'low',i));[0,1,2].forEach(i=>add(d+st.v*.62,'bar',i));break;
case'zig':{const f=st.zig=clamp((st.zig??1)+(st.zig===0?1:st.zig===2?-1:pick([-1,1])),0,2);others(f).forEach(i=>add(d,'tall',i));coins(d-4,f,4);break}}}
const INTRO=['lowC','tallC','barC','low','tall2','bar','low','tall'];
function plan(){while(st.next<st.dist+130){const s=st.sec,L=lvl();let pat,gap=1;
if(s.kind==='intro'){pat=INTRO[s.i++];gap=1.15}
else if(s.kind==='calm'){pat=s.left===2?'coins':pick(['coins','low','bar']);gap=1.22}
else if(s.kind==='build'){pat=pick(['low','tall','bar','tall2',L?'wide':'low'])}
else if(s.kind==='zig'){pat='zig';gap=.92}
else{pat=pick([['low','tall2','bar','tall'],['wide','lows3','bars3','tall2','low','bar'],['wide','lows3','bars3','mix3','moving','tall2'],['wide','lows3','bars3','mix3','moving','combo','tall2']][L]);gap=.84}
row(st.next,pat);const adv=st.v*clamp(1.08-st.dist/2400,.6,1.08)*gap*(pat==='combo'?1.9:1);
if(st.next>st.pickAt&&pat!=='combo'){const d0=st.next,safe=[0,1,2].filter(i=>!st.obs.some(q=>q.d===d0&&q.type==='tall'&&Math.abs(q.x-(i-1)*LW)<q.w/2+.3));
add(d0+adv*.5,PICKS[st.pickN++%4],pick(safe.length?safe:[1]),{y:.62});st.pickAt=st.next+rnd(290,390)}
st.next+=adv;
if(--s.left<=0){const seq=['calm','build','dense','calm','zig','dense'],kind=seq[st.secN++%seq.length];st.sec={kind,left:{calm:3,build:5,dense:6+L,zig:5}[kind],i:0}}}}

/* input: buffered, so a press just before landing still counts */
const A={
left(){if(st.mode==='run'&&st.lane>-1){st.lane--;st.lastMove=st.t}},
right(){if(st.mode==='run'&&st.lane<1){st.lane++;st.lastMove=st.t}},
jump(hold){if(st.mode==='over'){if(st.t-st.ot>.6){if(ended)return finish();reset('run');sr.textContent=t.running}return}if(st.mode!=='run')return;st.jbuf=.13;st.hold=true;st.holdT=hold||0},
release(){if(!st.holdT)st.hold=false},
down(){if(st.mode!=='run')return;if(st.y>0){st.vy=Math.min(st.vy,-13);st.sbuf=.3}else st.slide=SLIDE}};
function show(){if(open)return;open=true;ended=false;paint();reset('idle');layer.hidden=false;mode('wait');fit();layer.focus({preventScroll:true});sr.textContent=t.intro;
addEventListener('keydown',key);addEventListener('keyup',keyUp);last=0;cancelAnimationFrame(raf);raf=requestAnimationFrame(frame)}
function start(){show();if(st.mode!=='idle')return;paint();reset('run');mode('run');layer.focus({preventScroll:true});sr.textContent=t.running}
function close(){if(!open)return;open=false;cancelAnimationFrame(raf);removeEventListener('keydown',key);removeEventListener('keyup',keyUp);layer.hidden=true;mode();sr.textContent='';
if(ended){ended=false;o.onFinish()}else o.onClose()}
function finish(){ended=false;close();o.onFinish()}
function key(e){const k=e.key,ae=document.activeElement,free=!ae||ae===document.body||ae===layer;
if(k==='Escape'){e.preventDefault();return close()}
if(st.mode==='idle'){if((k===' '||k==='Enter')&&free&&!e.repeat){e.preventDefault();start()}return}
if(!free&&ae!==exitB)return;if(ae===exitB&&(k===' '||k==='Enter'))return;
if(k==='ArrowLeft'||k==='a'){if(!e.repeat)A.left()}else if(k==='ArrowRight'||k==='d'){if(!e.repeat)A.right()}
else if(k==='ArrowUp'||k===' '||k==='w'||k==='Enter'){if(!e.repeat)A.jump()}else if(k==='ArrowDown'||k==='s'){if(!e.repeat)A.down()}else return;e.preventDefault()}
function keyUp(e){if(st.mode==='run'&&(e.key==='ArrowUp'||e.key===' '||e.key==='w'))A.release()}
let p0=null;
c.addEventListener('click',e=>{if(st.mode==='idle'&&e.clientY-layer.getBoundingClientRect().top>cam.hz+20)start()});
c.addEventListener('pointerdown',e=>{if(st.mode==='idle')return;e.preventDefault();try{c.setPointerCapture(e.pointerId)}catch{}p0={x:e.clientX,y:e.clientY,used:false}});
c.addEventListener('pointermove',e=>{if(!p0||p0.used)return;const dx=e.clientX-p0.x,dy=e.clientY-p0.y,ax=Math.abs(dx),ay=Math.abs(dy);if(Math.max(ax,ay)<22)return;
p0.used=true;if(ax>ay)dx<0?A.left():A.right();else if(dy<0)A.jump(.3);else A.down()});
c.addEventListener('pointerup',()=>{if(p0&&!p0.used){A.jump();st.hold=false}p0=null});
c.addEventListener('pointercancel',()=>p0=null);
exitB.addEventListener('click',close);

/* rules */
const mult=()=>1+Math.min(4,Math.floor(st.combo/6));
const say=(txt,fx)=>{st.toast={txt,t:0,fx}};
const learn=b=>{if(!(learned&b)){learned|=b;ls(LKEY,learned)}};
function reward(n,near,q){st.combo++;st.comboT=3;const v=n*mult();st.pts+=v;if(near){st.pops.push({x:cam.cx+(q.x>=st.px?1:-1)*cam.rw*.46,y:cam.py-cam.S*.22,txt:t.near+' +'+v,t:0,fx:1});st.scare=.6;st.sdir=q.x>=st.px?1:-1}}
function take(q,z){const k=q.type;st.picks[k]=(st.picks[k]||0)+1;
if(k==='bat'){if(st.lives<3){st.lives++;say(t.bat)}else{st.pts+=50;say(t.full+' +50')}}else{if(k==='mag')st.mag=5;else if(k==='spring')st.spr=5;else st.wind=4.5;say(t[k])}
const p=P(q.x,q.y,z);burst(p.x,p.y,OR,12,150);st.P.push({ring:1,x:p.x,y:p.y,r:6,l:1,d:2.2})}
function stumble(){st.mode='over';st.ot=st.t;st.av=7;st.shake=RM?0:.3;st.flash=RM?.25:0;const p=P(st.px,.1,0);burst(p.x,p.y,LIGHT,16,130)}
function step(dt){st.t+=dt;
if(st.mode==='run'){
st.wind=Math.max(0,st.wind-dt);st.mag=Math.max(0,st.mag-dt);st.spr=Math.max(0,st.spr-dt);st.inv=Math.max(0,st.inv-dt);st.shake=Math.max(0,st.shake-dt);st.flash=Math.max(0,st.flash-dt);const wk=st.wind>0?1.3:1;
st.v=(V0+VADD*(1-Math.exp(-st.dist/1100)))*wk;st.dist+=st.v*dt;st.pts+=st.v*dt*(st.wind>0?2:1);st.run+=st.v*dt*1.25;
plan();
const tx=st.lane*LW;if(RM)st.px+=(tx-st.px)*Math.min(1,dt*14);else{st.pv+=((tx-st.px)*300-st.pv*24)*dt;st.px+=st.pv*dt}
st.jbuf-=dt;st.sbuf-=dt;if(st.holdT>0){st.holdT-=dt;if(st.holdT<=0)st.hold=false}
if(st.y<=0&&st.jbuf>0){st.vy=JV*(st.spr>0?1.42:1);st.y=.001;st.jbuf=0;st.slide=0;st.jumpT=st.t}
if(st.y>0){st.vy-=(st.vy>0?(st.hold?G_HOLD:G_TAP):G_DOWN)*dt;st.y+=st.vy*dt;
if(st.y<=0){st.y=0;st.vy=0;if(st.sbuf>0)st.slide=SLIDE;const p=P(st.px,0,0);burst(p.x,p.y,LIGHT,8,80)}}
st.slide=Math.max(0,st.slide-dt);st.scare=Math.max(0,st.scare-dt);
st.av+=((-st.pv*.06-st.vy*.012-st.aa)*140-st.av*9)*dt;st.aa=clamp(st.aa+st.av*dt,-.7,.7);
if(st.comboT>0){st.comboT-=dt;if(st.comboT<=0)st.combo=0}
if(st.best0>0&&!st.recT&&st.pts>st.best0){st.recT=st.t;say(t.rec,1)}
for(const q of st.obs){
if(q.mv)q.x=q.x0+Math.sin(st.t*1.5+q.ph)*LW*.5;q.wob=Math.max(0,(q.wob||0)-dt*3);
const z=q.d-st.dist;if(st.mag>0&&q.type==='coin'&&!q.done&&z<18){const k=Math.min(1,dt*(z<6?12:4));q.x+=(st.px-q.x)*k;q.y+=(st.y+.5-q.y)*k}
if(q.done||z>.32)continue;const dx=Math.abs(st.px-q.x);
if(q.type==='coin'){if(z<-.6)q.done=1;else if(dx<.62&&Math.abs(st.y+.5-q.y-(st.slide?.25:0))<.8){q.done=2;st.coins++;reward(5);const p=P(q.x,q.y,z);burst(p.x,p.y,OR,5,90)}continue}
if(!SOLID[q.type]){if(z<-.6)q.done=1;else if(dx<.72&&st.y<1.6){q.done=2;take(q,z)}continue}
const hitX=dx<q.w/2+.26;
if(z>-.32){if(hitX&&st.inv<=0&&((q.type==='tall'&&st.y<1.85)||(q.type==='low'&&st.y<.45)||(q.type==='bar'&&!(st.slide>0&&st.y<=0)&&st.y<1.7))){q.wob=1;
if(st.lives>0){st.lives--;st.inv=1.5;st.shake=RM?0:.12;st.flash=RM?.2:0;st.hits++;say(t.used);continue}
return stumble()}continue}
q.done=1;/* passed: what did the player just do, and was it close? */
if(hitX&&q.type==='low'&&st.y>0)learn(1);if(hitX&&q.type==='bar'&&st.slide>0)learn(4);if(!hitX&&q.type==='tall'&&st.t-st.lastMove<2.5)learn(2);
const late=st.t-st.lastMove<.3&&dx<q.w/2+1.0&&!hitX,lateJump=hitX&&q.type==='low'&&st.t-st.jumpT<.24,lateSlide=hitX&&q.type==='bar'&&st.slide>SLIDE-.2;
if(late||lateJump||lateSlide){q.wob=1;st.near++;reward(15,1,q)}}
st.obs=st.obs.filter(q=>q.d-st.dist>-6);
}else if(st.mode==='over'){st.run+=st.v*dt*1.6;st.av+=(-st.aa*150-st.av*4.5)*dt;st.aa=clamp(st.aa+st.av*dt,-.7,.7);if(!st.puff&&st.t-st.ot>.42){st.puff=1;const p=P(st.px,0,0);burst(p.x,p.y,LIGHT,18,110)}if(st.y>0){st.vy-=G_DOWN*dt;st.y=Math.max(0,st.y+st.vy*dt)}st.px+=(clamp(st.px,-LW,LW)-st.px)*Math.min(1,dt*8);st.shake=Math.max(0,st.shake-dt);st.flash=Math.max(0,st.flash-dt);st.v*=Math.exp(-5*dt);st.dist+=st.v*dt}}
const score=()=>Math.round(st.pts);

/* drawing: flat, grey and black with one orange */
function burst(px,py,col,n,sp){if(RM)n=Math.ceil(n/3);for(let i=0;i<n;i++){const a=rnd(Math.PI,TAU),v=rnd(.3,1)*sp;st.P.push({x:px,y:py,vx:Math.cos(a)*v,vy:Math.sin(a)*v,r:rnd(1.5,3.2),l:1,d:rnd(1.8,3.2),col})}}
function shadow(px,py,rx,a){x.save();x.translate(px,py);x.scale(1,.24);const g=x.createRadialGradient(0,0,0,0,0,rx);g.addColorStop(0,'rgb(9 9 11 / '+a+')');g.addColorStop(1,'rgb(9 9 11 / 0)');x.fillStyle=g;x.beginPath();x.arc(0,0,rx,0,TAU);x.fill();x.restore()}
function board(cx,top,w,h){if(h<2.2){x.fillStyle=OR;x.fillRect(cx-w/2,top,w,Math.max(1,h));return}x.save();x.beginPath();x.roundRect(cx-w/2,top,w,h,h*.16);x.fillStyle='#fff';x.fill();x.clip();x.strokeStyle=OR;x.lineWidth=h*.36;x.beginPath();for(let i=-w;i<w;i+=h*.9){x.moveTo(cx+i,top+h+2);x.lineTo(cx+i+h*1.1,top-2)}x.stroke();x.restore();x.strokeStyle='rgb(255 255 255 / .55)';x.lineWidth=Math.max(1,h*.06);x.beginPath();x.moveTo(cx-w/2+h*.2,top+h*.13);x.lineTo(cx+w/2-h*.2,top+h*.13);x.stroke();x.strokeStyle=INK;x.lineWidth=Math.max(1.2,h*.08);x.beginPath();x.roundRect(cx-w/2,top,w,h,h*.16);x.stroke()}
function thing(q,z){
const g=P(q.x,0,z),k=g.k,W=q.w*k,cx=g.x+(q.wob?Math.sin(st.t*46)*q.wob*3:0),Y=h=>P(q.x,h,z).y;
if(q.type==='coin'){const p=P(q.x,q.y,z);x.fillStyle=OR;x.beginPath();x.arc(p.x,p.y,Math.max(1.2,.12*k),0,TAU);x.fill();return}
if(!SOLID[q.type]){const hov=RM?0:Math.sin(st.t*3.4+q.d)*.07,p=P(q.x,q.y+hov,z),s=Math.max(5,.6*k);if(k>9)shadow(g.x,g.y,.3*k,.16);
x.fillStyle=OR;x.globalAlpha=.13+(RM?0:.06*Math.sin(st.t*5+q.d));x.beginPath();x.arc(p.x,p.y,s*.78,0,TAU);x.fill();x.globalAlpha=1;icon(q.type,p.x,p.y,s);x.fillStyle='rgb(255 255 255 / .75)';x.beginPath();x.ellipse(p.x-s*.34,p.y-s*.42,s*.13,s*.07,-.6,0,TAU);x.fill();return}
if(k>9)shadow(cx,g.y,W*.62,.14);
const top=q.type==='tall'?1.78:q.type==='bar'?1.62:.7,legs=q.w>LW?[-.42,0,.42]:[-.36,.36];
x.strokeStyle=INK;x.lineWidth=Math.max(1,.055*k);x.lineCap='round';x.beginPath();
for(const f of legs){const lx=cx+f*W;x.moveTo(lx,g.y);x.lineTo(lx,Y(top+.1));x.moveTo(lx-.11*k,g.y);x.lineTo(lx+.11*k,g.y)}x.stroke();
const b=(lo,hi)=>board(cx,Y(hi),W,Y(lo)-Y(hi));
if(q.type==='low')b(.28,.7);else if(q.type==='tall'){b(.28,.7);b(.82,1.24);b(1.36,1.78)}else b(1.05,1.5)}
/* the figure: a small round maintenance robot on one wheel, drawn in units, origin at the wheel's foot, seen from behind */
const ln=(pts,w,col=BOT)=>{x.strokeStyle=col;x.lineWidth=w;x.lineCap='round';x.lineJoin='round';x.beginPath();x.moveTo(pts[0],pts[1]);for(let i=2;i<pts.length;i+=2)x.lineTo(pts[i],pts[i+1]);x.stroke()};
const dot=(cx,cy,r,col=BOT)=>{x.fillStyle=col;x.beginPath();x.arc(cx,cy,r,0,TAU);x.fill()};
const box=(l,tp,w,h,r,col=BOT)=>{x.fillStyle=col;x.beginPath();x.roundRect(l,tp,w,h,r);x.fill()};
function bot(p){
const f=p.sit,drop=p.sl?.17:f*.235-Math.sin(Math.PI*f)*.12,bob=p.mv?-Math.abs(p.c)*.025:p.idle?Math.sin(p.t*1.8)*.012:0,wh=p.air?.15:.27,roll=p.mv||p.sl||f?p.run*.06:0;
/* the wheel: its tread runs while it rolls; pulled in for a jump; when the robot plops down, it tips out and keeps spinning */
x.save();if(f){x.translate(.24*f,-.03*f);x.rotate(1.25*f)}
box(-.085,-wh,.17,wh,.07,C.wheel);for(let i=0;i<4;i++){const ty=-wh+.02+((roll+i*.065)%.26+.26)%.26;if(ty<-.035)ln([-.055,ty+.018,0,ty,.055,ty+.018],.02,C.shell)}
for(const sd of[-1,1]){if(!f)ln([sd*.1,-wh*.52,sd*.14,-.3+drop],.035,PANEL);dot(sd*.1,-wh*.52,.036,GREY)}x.restore();
const turn=p.idle&&!RM?Math.max(0,Math.sin(p.t*.55)-.86)*7*Math.sin(p.t*5):0;/* now and then it looks around */
x.translate(0,-.5+drop+bob);x.rotate((p.mv?p.s*.05:0)-f*.12+turn*.09);if(p.sl)x.scale(1.14,.72);else if(f)x.scale(1+.1*f,1-.12*f);if(p.turn)x.scale(1-.3*Math.sin(Math.PI*clamp(p.face,0,1)),1);
for(const sd of[-1,1]){const hx=sd*(.39+.06*f),hy=p.air?-.14:f?.02+.21*f:.13-sd*p.s*(p.mv?.06:0);ln([sd*.26,.03,hx,hy],.065);dot(hx,hy,.047,PANEL)}
dot(0,0,.29);/* body: lower shell a shade darker, an orange belt, a light rim on the upper left */
x.save();x.beginPath();x.arc(0,0,.29,0,TAU);x.clip();box(-.3,.11,.6,.2,0,C.shell);box(-.3,.095,.6,.022,0,OR);x.restore();
x.strokeStyle='#a1a1aa';x.lineWidth=.022;x.lineCap='round';x.beginPath();x.arc(0,0,.262,Math.PI*1.1,Math.PI*1.52);x.stroke();
/* its back: a hatch with vents; the visor with its eyes shows when it faces us or glances over its shoulder */
const fc=clamp(p.face||0,0,1),fd=p.fdir||1;
if(fc<.98){x.save();x.translate(-fd*fc*.2,0);x.scale(1-fc,1);box(-.15,-.12,.3,.21,.06,PANEL);for(const vy of[-.065,-.015,.035])ln([-.085,vy,.085,vy],.022,BOT);x.restore()}
if(fc>.02){x.save();x.translate(fd*(1-fc)*.21,0);x.scale(fc,1);box(-.2,-.15,.4,.2,.1,'#09090b');x.strokeStyle=PANEL;x.lineWidth=.014;x.beginPath();x.roundRect(-.2,-.15,.4,.2,.1);x.stroke();
const ex=clamp((p.look||0)+turn*.6,-1,1)*.04,blink=f<.5&&!p.scare&&(p.t%3.4)<.12,er=p.scare?.06:.044;
for(const sd of[-1,1]){const cx=sd*.085+ex,cy=-.05;
if(f>.5){ln([cx-.03,cy-.03,cx+.03,cy+.03],.022,OR);ln([cx-.03,cy+.03,cx+.03,cy-.03],.022,OR)}
else if(blink)ln([cx-.04,cy,cx+.04,cy],.024,OR);else{dot(cx,cy,er,OR);dot(cx-er*.3,cy-er*.3,er*.28,'#fed7aa')}}
x.restore()}
if(f>.75&&!RM)for(let i=0;i<3;i++){const an=p.t*3.2+i*TAU/3,sx=Math.cos(an)*.33,sy=-.5+Math.sin(an)*.08,sz=.075*(1+.25*Math.sin(an));/* small stars circle above its head */
x.globalAlpha=(f-.75)*4*(.8+.2*Math.sin(an));x.fillStyle=OR;x.beginPath();for(let k=0;k<8;k++){const rr=k%2?sz*.42:sz,ka=k*Math.PI/4+p.t;x.lineTo(sx+Math.cos(ka)*rr,sy+Math.sin(ka)*rr)}x.closePath();x.fill();x.globalAlpha=1}
x.translate(0,-.27);x.rotate(f*.3+(p.ant||0));ln([0,0,0,-.16],.04);/* the antenna swings on a spring; when it sits, it droops and the light blinks slowly */
const calm=f||p.idle,dim=!RM&&(f?((p.ot||9)<1.5?Math.sin(p.t*24)<.3:Math.sin(p.t*2.6)<.4):p.idle&&Math.sin(p.t*2.6)<0),a=x.globalAlpha;x.globalAlpha=a*(dim?.3:1);dot(0,-.21,.078,OR);dot(-.022,-.232,.022,'#fed7aa');x.globalAlpha=a;
if(!calm&&!RM&&Math.sin(p.t*7)>0){x.strokeStyle=OR;x.globalAlpha=a*.45;x.lineWidth=.025;x.beginPath();x.arc(0,-.21,.125,0,TAU);x.stroke();x.globalAlpha=a}}
function runner(){
const g=P(st.px,0,0),u=(g.y-P(st.px,1,0).y)*1.12,air=st.y>0,sl=st.slide>0&&!air,ov=st.mode==='over',ot=st.t-st.ot,f=ov?clamp((ot-.15)*2.6,0,1):0,run=st.mode==='run';
shadow(g.x,g.y,.46*u*(1-Math.min(.5,st.y*.3)),.26);
if(run&&!RM){/* dust behind the wheel, sparks while it slides */
if(sl)for(const sd of[-1,1])st.P.push({x:g.x+sd*.2*u,y:g.y-2,vx:sd*rnd(30,110),vy:rnd(-90,-20),r:rnd(1,2.2),l:1,d:4,col:OR});
else if(!air&&Math.random()<.3)st.P.push({x:g.x+rnd(-4,4),y:g.y,vx:rnd(-22,22),vy:rnd(-30,-8),r:rnd(1.6,3.4),l:.8,d:2.4,col:LIGHT})}
x.save();x.translate(g.x,g.y-st.y*u/1.12);x.rotate(ov?.16*Math.cos(ot*9)*(1-f):RM?0:clamp(st.pv*.03,-.22,.22));x.scale(u,u);if(st.inv>0&&Math.sin(st.t*32)>0)x.globalAlpha=.35;
bot({s:Math.sin(st.run),c:Math.cos(st.run),run:st.run,air,sl,sit:f,mv:run&&!air&&!sl,idle:st.mode==='idle',t:st.mode==='idle'?idleT:st.t,look:0,scare:st.scare>0,ant:st.aa,ot,
face:st.mode==='idle'?1:ov?f:st.t<.6?.5+.5*Math.cos(Math.PI*st.t/.6):st.scare>0?.45*Math.sin(Math.PI*clamp(1-st.scare/.6,0,1)):0,fdir:st.scare>0?st.sdir:1,turn:run&&st.t<.6});x.restore()}
/* a shout: big, bold and orange; it pops in with an overshoot, floats up a little and fades */
function shout(q,cx,cy,size,dt,room){q.t+=dt;if(q.stay)q.t=Math.min(q.t,1);const tt=q.t,L=1.7;if(tt>L)return false;
const pop=RM?1:tt<.12?.6+.55*tt/.12:tt<.26?1.15-.15*(tt-.12)/.14:1,a=Math.min(1,tt*10,(L-tt)*3);
x.save();x.translate(cx,cy-(RM?0:tt*16));if(q.fx&&!RM&&tt<.5)x.rotate(Math.sin(tt*34)*.07*(1-tt*2));x.scale(pop,pop);x.globalAlpha=a;
let fs=size;x.font='800 '+fs+'px '+FONT;const tw=x.measureText(q.txt).width,max=room||cam.w-32;if(tw>max){fs*=max/tw;x.font='800 '+fs+'px '+FONT}
x.textAlign='center';x.lineJoin='round';x.strokeStyle=bgA(1);x.lineWidth=fs*.3;x.strokeText(q.txt,0,0);x.strokeStyle=C.rim;x.lineWidth=fs*.11;x.strokeText(q.txt,0,0);x.fillStyle=OR;x.fillText(q.txt,0,0);x.restore();
if(q.fx&&!q.sp&&!RM){q.sp=1;burst(cx,cy-6,OR,16,210)}return true}
/* pickups: each has its own shape, also used small in the top row */
function icon(k,cx,cy,s){x.save();x.translate(cx,cy);x.scale(s/20,s/20);x.lineCap='round';x.lineJoin='round';
if(k==='bat'){x.fillStyle=INK;x.beginPath();x.roundRect(-3,-12,6,4,1.5);x.fill();x.beginPath();x.roundRect(-7,-9,14,20,3.5);x.fill();x.fillStyle=OR;x.beginPath();x.roundRect(-4,-1,8,9,1.5);x.fill()}
else if(k==='mag'){x.strokeStyle=INK;x.lineWidth=6;x.lineCap='butt';x.beginPath();x.moveTo(-6,5);x.lineTo(-6,-2);x.arc(0,-2,6,Math.PI,0);x.lineTo(6,5);x.stroke();x.strokeStyle=OR;x.beginPath();x.moveTo(-6,11);x.lineTo(-6,5);x.moveTo(6,11);x.lineTo(6,5);x.stroke()}
else if(k==='spring'){x.strokeStyle=OR;x.lineWidth=3;x.beginPath();x.moveTo(-6,7);for(let i=0;i<4;i++)x.lineTo(i%2?-6:6,3.5-i*4);x.stroke();x.strokeStyle=INK;x.lineWidth=3.5;x.beginPath();x.moveTo(-8,10.5);x.lineTo(8,10.5);x.moveTo(-8,-11.5);x.lineTo(8,-11.5);x.stroke()}
else{x.strokeStyle=OR;x.lineWidth=3.5;for(const y of[4,-5]){x.beginPath();x.moveTo(-7,y+4);x.lineTo(0,y-3);x.lineTo(7,y+4);x.stroke()}}
x.restore()}
/* a big calm arrow for the first rounds; on a phone it carries a finger dot at its tail */
function arrow(cx,cy,dir,s){x.save();x.translate(cx,cy);x.rotate({u:0,r:Math.PI/2,d:Math.PI,l:-Math.PI/2}[dir]);x.lineCap='round';x.lineJoin='round';
for(const[col,w]of[[bgA(.9),s*.34],[INK,s*.16]]){x.strokeStyle=col;x.lineWidth=w;x.beginPath();x.moveTo(0,s*.5);x.lineTo(0,-s*.5);x.moveTo(-s*.32,-s*.18);x.lineTo(0,-s*.5);x.lineTo(s*.32,-s*.18);x.stroke()}
if(TOUCH){x.fillStyle=OR;x.beginPath();x.arc(0,s*.5,s*.16,0,TAU);x.fill()}x.restore()}
function hint(){
if(learned===7||st.mode!=='run')return;const lx=st.lane*LW;let q=null;
for(const r of st.obs){const z=r.d-st.dist;if(SOLID[r.type]&&!r.done&&z>1&&z<st.v*1.7&&Math.abs(lx-r.x)<r.w/2+.3&&(!q||r.d<q.d))q=r}if(!q)return;
const need=q.type==='low'?1:q.type==='bar'?4:2;if(learned&need)return;
let dir=need===1?'u':need===4?'d':'r';const word=need===1?t.jump:need===4?t.slide:t.dodge;
if(need===2){const free=[-1,0,1].filter(l=>!st.obs.some(r=>Math.abs(r.d-q.d)<1&&r.type==='tall'&&Math.abs(l*LW-r.x)<r.w/2+.3)).sort((a,b)=>Math.abs(a-st.lane)-Math.abs(b-st.lane))[0];if(free==null)return;dir=free<st.lane?'l':'r'}
const g=P(st.px,0,0),cy=cam.py-cam.S*.47,s=Math.min(54,cam.rw*.15),a=RM?1:.75+.25*Math.sin(st.t*6);x.globalAlpha=a;arrow(g.x,cy,dir,s);x.globalAlpha=1;
x.textAlign='center';x.font='600 13px '+FONT;x.lineJoin='round';x.strokeStyle=bgA(.9);x.lineWidth=4;const txt=TOUCH?(need===1?t.tap:t.swipe)+': '+word:word;x.strokeText(txt,g.x,cy-s*.5-16);x.fillStyle=INK;x.fillText(txt,g.x,cy-s*.5-16)}
function quad(a,b,d,e){x.beginPath();x.moveTo(a.x,a.y);x.lineTo(b.x,b.y);x.lineTo(d.x,d.y);x.lineTo(e.x,e.y);x.closePath()}
function draw(dt){
const w=cam.w,H=cam.h,sk=st.shake*12;st.sx=sk?rnd(-sk,sk):0;st.sy=sk?rnd(-sk,sk):0;
layout();x.clearRect(0,0,w,H);const e=1.5*LW,FAR=900,NEAR=1.4-cam.CD,idle=st.mode==='idle';
pale+=((idle?1:0)-pale)*Math.min(1,dt*5+(RM?1:0));
const rg=x.createLinearGradient(0,cam.hz,0,H);rg.addColorStop(0,C.road0);rg.addColorStop(1,C.road1);x.fillStyle=rg;quad(P(-e,0,NEAR),P(e,0,NEAR),P(e,0,FAR),P(-e,0,FAR));x.fill();
x.fillStyle=C.streak;for(let i=0;i<6;i++){const z=((i*17-st.dist)%102+102)%102-4,lx=((i*7)%3-1)*LW+(i%2?.22:-.2);if(z<NEAR)continue;quad(P(lx-.09,0,z),P(lx+.09,0,z),P(lx+.09,0,z+8),P(lx-.09,0,z+8));x.fill()}
x.fillStyle=C.edge;for(const s of[-1,1]){quad(P(s*(e-.16),0,NEAR),P(s*(e-.1),0,NEAR),P(s*(e-.1),0,FAR),P(s*(e-.16),0,FAR));x.fill()}
x.fillStyle=LIGHT;for(let z=-12-(st.dist%4);z<220;z+=4){if(z<NEAR)continue;for(const lx of[-.5,.5]){quad(P(lx*LW-.028,0,z),P(lx*LW+.028,0,z),P(lx*LW+.028,0,z+1.7),P(lx*LW-.028,0,z+1.7));x.fill()}}
x.strokeStyle=INK;x.lineWidth=1.5;for(const s of[-1,1]){const a=P(s*e,0,NEAR),b=P(s*e,0,FAR);x.beginPath();x.moveTo(a.x,a.y);x.lineTo(b.x,b.y);x.stroke()}
const fast=st.mode==='run'&&!RM?clamp((st.v-18)/9,0,1):0;/* speed lines beside the road at high pace, orange with a tailwind */
if(fast>0){x.strokeStyle=st.wind>0?OR:GREY;x.lineWidth=2;x.lineCap='round';x.globalAlpha=fast*.5;for(let i=0;i<10;i++){const z=((i*8-st.dist*1.5)%80+80)%80-3,s=i%2?1:-1,ox=s*(e+.45+(i%3)*.35),a=P(ox,.4,z),b=P(ox,.4,z+2+fast*3);x.beginPath();x.moveTo(a.x,a.y);x.lineTo(b.x,b.y);x.stroke()}x.globalAlpha=1}
const os=st.obs.filter(q=>q.done!==2&&!(st.mode==='over'&&!SOLID[q.type]&&q.d-st.dist<9)).sort((a,b)=>b.d-a.d);
for(const q of os){const z=q.d-st.dist;if(z>=0&&z<190)thing(q,z)}
if(pale>.01){x.fillStyle=bgA(pale*.45);x.fillRect(0,0,w,H)}/* while waiting the road is pale */
runner();for(const q of os){const z=q.d-st.dist;if(z<0&&z>(!SOLID[q.type]?-.8:-1.3))thing(q,z)}
for(let i=st.P.length-1;i>=0;i--){const p=st.P[i];p.l-=dt*p.d;if(p.l<=0){st.P.splice(i,1);continue}x.globalAlpha=p.l;
if(p.ring){p.r+=dt*110;x.strokeStyle=OR;x.lineWidth=2;x.beginPath();x.arc(p.x,p.y,p.r,0,TAU);x.stroke();continue}
p.vy+=380*dt;p.x+=p.vx*dt;p.y+=p.vy*dt;x.fillStyle=p.col;x.beginPath();x.arc(p.x,p.y,p.r,0,TAU);x.fill()}x.globalAlpha=1;
/* the road disappears into the page towards the distance and the bottom */
const fade=(g,stops)=>{stops.forEach(([s,al])=>g.addColorStop(s,bgA(al)));x.fillStyle=g},ft=cam.hz+cam.S*.24;
fade(x.createLinearGradient(0,cam.hz,0,ft),[[0,1],[.22,1],[.55,.6],[1,0]]);x.fillRect(0,0,w,ft+1);
fade(x.createLinearGradient(0,H,0,H-64),[[0,1],[1,0]]);x.fillRect(0,H-64,w,64);
hint();
const hx=cam.cx-Math.min(232,w/2-16),hy=cam.hz+34;x.textAlign='left';
if(st.mode==='run'){
const sc=fmt(score());x.fillStyle=INK;x.font='650 22px '+FONT;x.fillText(sc,hx,hy);const m=mult(),tw=x.measureText(sc).width;
if(m>1){const k=clamp(st.comboT/3,0,1);x.fillStyle=OR;x.globalAlpha=.3+.7*k;x.font='700 '+(12+5*k)+'px '+FONT;x.fillText('×'+m,hx+tw+10,hy-1);x.globalAlpha=1}
const ry=hy+(st.best0>0?44:27);if(st.best0>0){x.font='500 12px '+FONT;x.fillStyle=GREY;x.fillText(t.record+' '+fmt(Math.max(st.best0,score())),hx,hy+17)}
let ix=hx;for(let i=0;i<st.lives;i++){icon('bat',ix+7,ry,17);ix+=19}if(st.lives)ix+=12;/* lives only once there is one */
for(const[k,left,full]of[['mag',st.mag,5],['spring',st.spr,5],['wind',st.wind,4.5]])if(left>0){const cx2=ix+14,cy2=ry,r=14*(left<1.2&&!RM?1+.1*Math.sin(st.t*16):1);
x.fillStyle=C.chip;x.beginPath();x.moveTo(cx2,cy2);x.arc(cx2,cy2,r,-Math.PI/2,-Math.PI/2+TAU*left/full);x.closePath();x.fill();x.strokeStyle=LIGHT;x.lineWidth=1;x.beginPath();x.arc(cx2,cy2,14,0,TAU);x.stroke();icon(k,cx2,cy2,13);ix+=36}}
x.textAlign='center';x.lineJoin='round';x.strokeStyle=bgA(.9);x.lineWidth=5;const tx=(s,px,py)=>{x.strokeText(s,px,py);x.fillText(s,px,py)};
const big=w<640?27:36;st.pops=st.pops.filter(p=>shout(p,clamp(p.x,76,w-76),p.y,big*.74,dt));
if(st.toast&&!shout(st.toast,w>=1000?cam.cx+cam.rw*.5+190:w-16-(w-150)/2,w>=1000?cam.hz+cam.S*.42:cam.hz+46,big,dt,w>=1000?0:w-150))st.toast=null;
const mid=cam.py-cam.S*.45;
if(idle){x.fillStyle=GREY;x.font='500 13px '+FONT;x.fillText(TOUCH||w<640?t.goT:t.go,cam.cx,cam.py+40)}
if(st.flash>0){x.fillStyle='rgb(9 9 11 / '+Math.min(.16,st.flash)+')';x.fillRect(0,0,w,H)}/* reduced motion: a short dim instead of a shake */
if(st.mode==='over'&&st.t-st.ot>.45){x.fillStyle=bgA(Math.min(.8,(st.t-st.ot-.45)*2.5));x.fillRect(0,0,w,H);runner()}
if(st.mode==='over'&&st.t-st.ot>.65){x.save();x.translate(cam.cx,mid-24);x.scale(1.6,1);const lg=x.createRadialGradient(0,0,0,0,0,w<640?150:185);lg.addColorStop(0,bgA(1));lg.addColorStop(.6,bgA(.96));lg.addColorStop(1,bgA(0));x.fillStyle=lg;x.globalAlpha=Math.min(1,(st.t-st.ot-.65)*4);x.beginPath();x.arc(0,0,190,0,TAU);x.fill();x.restore();
x.fillStyle=INK;x.font='650 26px '+FONT;tx(fmt(score())+' '+t.pts,cam.cx,mid-14);x.font='500 13px '+FONT;x.fillStyle=GREY;if(!st.rec)tx(t.record+' '+fmt(ls(KEY)),cam.cx,mid+8);else shout(st.recS||(st.recS={txt:t.rec,t:0,fx:1,stay:1}),cam.cx,mid-54,w<640?32:42,dt);x.font='500 13px '+FONT;x.strokeStyle=bgA(.9);x.lineWidth=5;x.textAlign='center';
x.fillStyle=GREY;tx(ended?t.cont:TOUCH||w<640?t.againT:t.again,cam.cx,mid+30)}}
function frame(now){if(!open)return;raf=requestAnimationFrame(frame);const idle=st.mode==='idle';if(!last)last=now;const dt=Math.min(.033,(now-last)/1000);
if(idle&&last!==now&&(now-last<(RM?500:66)||document.hidden))return;/* waiting costs almost nothing: a few frames per second */
last=now;idleT+=idle?(RM?.5:.066):0;const was=st.mode;if(!idle)step(dt);
if(was==='run'&&st.mode==='over'){st.rec=score()>st.best0;if(st.rec)ls(KEY,score());sr.textContent=t.over+': '+fmt(score())+' '+t.pts+'.'+(st.rec?' '+t.rec+'.':'')+' '+(ended?t.cont:t.again)}
draw(idle?.066:dt)}
return{open:show,start,close,isOpen:()=>open,end(){if(!open)return false;if(st.mode==='idle'){close();return false}ended=true;return true}}}`;
