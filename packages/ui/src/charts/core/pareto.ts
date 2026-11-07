import { chartDatumSvg, type ChartOptions, escapeXml, svgRoot } from "./svg";
export type ParetoOptions = ChartOptions & { labels:[string,string]; data:{label:string;value:number;prev:number}[]; locale?:string; format?:(value:number)=>string; displayWidth?:number };
export function paretoLayout(spec:ParetoOptions,size={width:spec.width??480,height:spec.height??280}) {
 const width=spec.displayWidth??size.width,height=Math.max(size.height,spec.data.length*34+44);
 const data=spec.data.map((d,index)=>{if(![d.value,d.prev].every(v=>Number.isFinite(v)&&v>=0))throw new RangeError('Pareto values must be finite and nonnegative.');return {...d,index};}).sort((a,b)=>Number(a.label.toLowerCase()==='rest')-Number(b.label.toLowerCase()==='rest')||b.value-a.value);
 const total=data.reduce((s,d)=>s+d.value,0),max=Math.max(1,...data.flatMap(d=>[d.value,d.prev]));if(!Number.isFinite(total))throw new RangeError('Pareto total must be finite.');
 const left=Math.min(112,width*.25),plot=width-left-30,rowHeight=(height-44)/Math.max(1,data.length);let sum=0;
 return {width,height,total,max,left,plot,rowHeight,rows:data.map((d,index)=>{sum+=d.value;return {...d,y:18+rowHeight*(index+.5),cumulative:total?sum/total:0};})};
}
export function renderParetoSvg(spec:ParetoOptions):string {
 const s=paretoLayout(spec);const number=spec.format??new Intl.NumberFormat(spec.locale??'en',{maximumSignificantDigits:15}).format;
 const percent=new Intl.NumberFormat(spec.locale??'en',{style:'percent',maximumFractionDigits:1});
 const color='var(--stdlib-chart-c1,#3b82f6)';const body:string[]=[];let line=`${s.left},18`;
 for(const row of s.rows){const bh=Math.min(s.rowHeight*.36,12),valueWidth=row.value/s.max*s.plot,prevWidth=row.prev/s.max*s.plot;
 const hatch=Array.from({length:Math.floor(prevWidth/5)},(_,i)=>`<line x1="${s.left+i*5}" x2="${s.left+i*5+4}" y1="${row.y+1+bh}" y2="${row.y+1}" stroke="${color}" stroke-width="1"/>`).join('');
 body.push(chartDatumSvg(`<rect x="${s.left}" y="${row.y-bh-1}" width="${valueWidth}" height="${bh}" rx="2" fill="${color}" stroke="none"/><rect x="${s.left}" y="${row.y+1}" width="${prevWidth}" height="${bh}" rx="2" fill="${color}" fill-opacity="0.14" stroke="${color}" stroke-width="0.8"/>${hatch}<rect class="k2b-chart-category-band" x="0" y="${row.y-s.rowHeight/2}" width="${s.width}" height="${s.rowHeight}" fill="transparent" pointer-events="none"/><text x="${s.left-8}" y="${row.y+4}" text-anchor="end" font-size="12" fill="var(--k2b-text,#27272a)">${escapeXml(row.label.length>Math.floor(s.left*(spec.displayWidth??296)/s.width/7)-1?row.label.slice(0,Math.max(1,Math.floor(s.left*(spec.displayWidth??296)/s.width/7)-2))+"…":row.label)}</text>`,{role:'item',index:row.index,label:row.label,anchor:[s.left+valueWidth,row.y],grid:[0,s.rows.indexOf(row)],values:[{key:'value',value:row.value,formatted:number(row.value)},{key:'previous',value:row.prev,formatted:number(row.prev)},{key:'change',value:row.prev?row.value/row.prev-1:0,formatted:row.prev?percent.format(row.value/row.prev-1):'–'},{key:'cumulative',value:row.cumulative,formatted:s.total?percent.format(row.cumulative):'–'}]},spec.inspect));line+=` ${s.left+row.cumulative*s.plot},${row.y}`;}
 body.push(`<line x1="${s.left+.8*s.plot}" x2="${s.left+.8*s.plot}" y1="18" y2="${s.height-26}" stroke="var(--k2b-warning-text,#92400e)" stroke-dasharray="5 4"/><text x="${s.left+.8*s.plot+4}" y="${s.height-30}" font-size="11" fill="var(--k2b-warning-text,#92400e)">80 %</text><polyline points="${line}" fill="none" stroke="var(--k2b-text-muted,#45454e)" stroke-width="1.5" pointer-events="none"/>`);
 for(let p=0;p<=5;p++)body.push(`<text x="${s.left+p/5*s.plot}" y="${s.height-5}" text-anchor="middle" font-size="11" fill="var(--k2b-text-muted,#45454e)">${escapeXml(percent.format(p/5))}</text>`);
 body.push(`<text x="${s.left}" y="12" font-size="11" fill="var(--k2b-text-muted,#45454e)">${escapeXml(spec.labels[0])} / ${escapeXml(spec.labels[1])}</text>`);
 return svgRoot({...s,className:spec.className},body.join(''));
}
