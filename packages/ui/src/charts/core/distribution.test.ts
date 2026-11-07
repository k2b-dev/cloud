import { expect,test } from 'bun:test';
import {treemapLayout,renderTreemapSvg} from './treemap';
import {paretoLayout,renderParetoSvg} from './pareto';
const treemap={groups:['A','B'],data:[{label:'Chairs',group:'A',value:6},{label:'Tables',group:'B',value:3},{label:'Other',group:'A',value:1},{label:'Zero',group:'B',value:0}]};
test('squarified treemap preserves area proportions, bounds, zeros and input indices',()=>{
 const s=treemapLayout(treemap,{width:600,height:300});expect(s.cells.reduce((v,c)=>v+c.width*c.height,0)).toBeCloseTo(180000);for(const c of s.cells){expect(c.width*c.height/180000).toBeCloseTo(c.value/10);expect(c.x+c.width).toBeLessThanOrEqual(600.00001);expect(c.y+c.height).toBeLessThanOrEqual(300.00001);}
 for(let i=0;i<s.cells.length;i++)for(let j=i+1;j<s.cells.length;j++){const a=s.cells[i]!,b=s.cells[j]!;expect(Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y))).toBeCloseTo(0);}
 expect(()=>treemapLayout({...treemap,data:[{label:'Bad',group:'A',value:-1}]})).toThrow();expect(renderTreemapSvg({...treemap,inspect:true})).not.toMatch(/NaN|Infinity/);
});
const pareto={labels:['Now','Before'] as [string,string],data:[{label:'Small',value:10,prev:0},{label:'Rest',value:100,prev:80},{label:'Main',value:90,prev:100}]};
test('Pareto sorts current values descending with Rest last and computes true cumulative shares',()=>{
 const s=paretoLayout(pareto);expect(s.rows.map(r=>r.label)).toEqual(['Main','Small','Rest']);expect(s.rows.map(r=>r.cumulative)).toEqual([.45,.5,1]);expect(s.rows.map(r=>r.index)).toEqual([2,0,1]);
 const svg=renderParetoSvg({...pareto,inspect:true});expect(svg).toContain('80 %');expect(svg).toContain('polyline');expect(svg).toContain('&quot;formatted&quot;:&quot;–&quot;');expect(svg).toContain('var(--stdlib-chart-c1,#3b82f6)');expect(svg).not.toMatch(/NaN|Infinity/);
 expect(()=>paretoLayout({...pareto,data:[{label:'Bad',value:1,prev:-2}]})).toThrow();
});
