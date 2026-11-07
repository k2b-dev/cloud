import {expect,test} from 'bun:test';import {chartKinds,chartTable} from './charts';
test('treemap and Pareto portable data validate nonnegative values and retain exact localized rows',()=>{
 const schema=chartKinds();const treemap=schema.parse({kind:'treemap',title:'Shares',groups:['A'],data:[{label:'Chair',group:'A',value:1234.5}]});expect(chartTable(treemap,'de').rows[0]!.cells).toMatchObject({label:'Chair',group:'A',value:'1.234,5',percent:'100 %'});
 const pareto=schema.parse({kind:'pareto',title:'Rank',labels:['Now','Before'],data:[{label:'A',value:120,prev:100},{label:'Rest',value:30,prev:0}]});const table=chartTable(pareto,'en');expect(table.rows[0]!.cells).toMatchObject({value:'120',previous:'100',change:'20%',cumulative:'80%'});expect(table.columns.find(c=>c.id==='value')?.label).toBe('Now');expect(table.rows[1]!.cells.change).toBe('–');
 expect(schema.safeParse({...pareto,data:[{label:'A',value:-1,prev:0}]}).success).toBe(false);
});
