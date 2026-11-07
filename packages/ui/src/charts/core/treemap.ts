import { chartDatumSvg, type ChartOptions, escapeXml, svgRoot } from "./svg";
export type TreemapOptions = ChartOptions & { groups:string[]; data:{label:string;group:string;value:number}[]; locale?:string; format?:(value:number)=>string; displayWidth?:number };
export function treemapLayout(spec:TreemapOptions,size={width:spec.width??480,height:spec.height??280}) {
 const width=spec.displayWidth??size.width,height=size.height;
 const data=spec.data.map((d,index)=>{if(!Number.isFinite(d.value)||d.value<0)throw new RangeError('Treemap values must be finite and nonnegative.');if(!spec.groups.includes(d.group))throw new RangeError('Treemap groups must contain every item group.');return {...d,index};});
 const total=data.reduce((s,d)=>s+d.value,0);if(!Number.isFinite(total))throw new RangeError('Treemap total must be finite.');
 const entries=data.filter(d=>d.value>0).sort((a,b)=>b.value-a.value).map(d=>({...d,area:d.value/(total||1)*width*height}));
 const cells:(typeof data[number]&{x:number;y:number;width:number;height:number})[]=[];
 let x=0,y=0,w=width,h=height;
 const worst=(areas:number[],side:number)=>{if(!areas.length||side<=0)return Infinity;const sum=areas.reduce((s,a)=>s+a,0),lo=Math.min(...areas),hi=Math.max(...areas);return Math.max(side*side*hi/(sum*sum),sum*sum/(side*side*lo));};
 let offset=0;
 while(offset<entries.length){
   const row=[entries[offset++]!];const side=Math.min(w,h);
   while(offset<entries.length&&worst(row.map(c=>c.area),side)>=worst([...row.map(c=>c.area),entries[offset]!.area],side))row.push(entries[offset++]!);
   const sum=row.reduce((s,c)=>s+c.area,0);const vertical=w>=h;const thickness=sum/(vertical?h:w);let pos=vertical?y:x;
   for(const d of row){const length=d.area/thickness;cells.push({...d,x:vertical?x:pos,y:vertical?pos:y,width:vertical?thickness:length,height:vertical?length:thickness});pos+=length;}
   if(vertical){x+=thickness;w=Math.max(0,w-thickness);}else{y+=thickness;h=Math.max(0,h-thickness);}
 }
 for(const d of data.filter(d=>d.value===0))cells.push({...d,x:0,y:0,width:0,height:0});
 return {width,height,total,cells};
}
export function renderTreemapSvg(spec:TreemapOptions):string {
 const scene=treemapLayout(spec);const number=spec.format??new Intl.NumberFormat(spec.locale??'en',{maximumSignificantDigits:15}).format;
 const percent=new Intl.NumberFormat(spec.locale??'en',{style:'percent',maximumFractionDigits:1});
 const body=scene.cells.map(c=>{
 const group=spec.groups.indexOf(c.group)%8+1;const color=`var(--stdlib-chart-c${group},${['#3b82f6','#10b981','#f59e0b','#8b5cf6','#ec4899','#06b6d4','#84cc16','#f97316'][group-1]})`;
 const text=c.width*(spec.displayWidth??296)/scene.width>Math.max(56,c.label.length*12+16)&&c.height>38?`<text x="${c.x+8}" y="${c.y+18}" font-size="12" font-weight="600" fill="var(--k2b-text,#27272a)">${escapeXml(c.label)}</text><text x="${c.x+8}" y="${c.y+33}" font-size="11" fill="var(--k2b-text-muted,#45454e)">${escapeXml(number(c.value))}</text>`:'';
 return chartDatumSvg(`<rect x="${c.x+1}" y="${c.y+1}" width="${Math.max(0,c.width-2)}" height="${Math.max(0,c.height-2)}" rx="4" fill="color-mix(in srgb,${color} 55%,var(--k2b-surface,#fff))" stroke="none"/>${text}`,{role:'item',index:c.index,label:c.label,anchor:[c.x+c.width/2,c.y+c.height/2],values:[{key:'group',value:c.group},{key:'value',value:c.value,formatted:number(c.value)},{key:'percent',value:scene.total?c.value/scene.total*100:0,formatted:scene.total?percent.format(c.value/scene.total):'–'}]},spec.inspect);
 }).join('');return svgRoot({...scene,className:spec.className},body);
}
