import {expect,test} from 'bun:test';import {CloudAiChartInputSchema} from './default-tool-contracts';import {parseCloudAiChartToolView} from './view-block';
test('treemap and Pareto model and saved-view paths retain the complete description',()=>{
 for(const spec of [{kind:'treemap',title:'Shares',groups:['A'],data:[{label:'Chair',group:'A',value:4}]},{kind:'pareto',title:'Rank',labels:['Now','Before'],data:[{label:'Chair',value:4,prev:3}]}]){expect(CloudAiChartInputSchema.safeParse(spec).success).toBe(true);expect(parseCloudAiChartToolView(spec)).toMatchObject({...spec,view:'chart'});}
});
