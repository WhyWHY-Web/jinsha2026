import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises'
import { dirname,join,resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { ecologyOptions,evaluateEcology,ecologyRseiLayer,stationEcology } from '../server/ecology.ts'
import { assessmentCsv,assessmentRows,verifyAssessment } from '../src/assessment-export.ts'
import { assessmentEvidence,verifySaved } from '../src/saved-runs.ts'

const scratch=await mkdtemp(join(tmpdir(),'jinsha-research-test-'))
const cover={林地:.6,草地灌丛:.2,农田:.1,建成区:0,裸地:.1,水体:0,湿地:0}
try {
  for(const folder of ['basin','gee','ecology'])await mkdir(join(scratch,folder),{recursive:true})
  const save=(file,data)=>writeFile(join(scratch,file),JSON.stringify(data))
  const stations=[{id:'a',name:'甲',lon:100,lat:28,zone:'区',type:'研究站',elev:2000,slope:10,relief:100,temp:15,precip:1000,lc:cover},
    {id:'b',name:'乙',lon:102,lat:28,zone:'区',type:'研究站',elev:1500,slope:20,relief:400,temp:22,precip:800,lc:{...cover,林地:.1,裸地:.6}}]
  const annual=[{station:'甲',year:2020,temp_c:15,precip_mm:1000},{station:'甲',year:2025,temp_c:15,precip_mm:1000},{station:'乙',year:2025,temp_c:22,precip_mm:800}]
  const polygon=(id,w,e)=>({type:'Feature',properties:{HYBAS_ID:id},geometry:{type:'Polygon',coordinates:[[[w,27],[e,27],[e,29],[w,29],[w,27]]]}})
  await Promise.all([save('stations.json',{stations}),save('climate_annual.json',annual),save('climate.json',{stations:{}}),
    save('gee/annual.json',{ndvi:{甲:[['2020',.4],['2025',.7]]}}),save('basin/jinsha_basin.geojson',{type:'FeatureCollection',features:[polygon(1,99,101),polygon(2,101,103)]})])
  const options=await ecologyOptions(scratch)
  assert.equal(options.metricDefinitions.length,18)
  const params=new URLSearchParams({scope:'basin',year:'2025',compareYear:'2020',scenario:'baseline'})
  const report=await evaluateEcology(scratch,params)
  assert.equal(report.summary.count,2);assert.equal(report.comparison.count,1)
  assert.equal(report.comparison.currentMeans.eei,report.stations[0].metrics.eei)
  assert.equal(report.comparison.delta.eei,0)
  assert.equal(report.summary.sampledBasins,2)
  const {run,...payload}=report
  assert.equal(run.sha256,createHash('sha256').update(JSON.stringify(payload)).digest('hex'))
  assert.equal((await evaluateEcology(scratch,params)).run.id,run.id)
  assert.equal(await verifyAssessment(report),true)
  const tampered=structuredClone(report);tampered.stations[0].metrics.eei++
  assert.equal(await verifyAssessment(tampered),false)
  const evidence=assessmentEvidence(report,'http://localhost:8732/?scene=results')
  assert.equal(await verifySaved(evidence),true)
  assert.equal(new URL(evidence.viewUrl).searchParams.get('compareYear'),'2020')
  assert.equal(assessmentCsv(report).includes(run.sha256),true)
  assert.equal(assessmentCsv(report).includes('2020'),true)
  assert.ok(assessmentRows(report).some(row=>row[0]==='两期共同样本' && row[1]==='1'))
  for(const scenario of options.scenarios) {
    const result=await evaluateEcology(scratch,new URLSearchParams({scope:'basin',year:'2025',scenario:scenario.id}))
    assert.equal(result.summary.count,2)
    assert.ok(result.stations.every(row=>Object.values(row.metrics).every(Number.isFinite)))
    assert.ok(result.stations.every(row=>Math.abs(Object.values(row.inputs.cover).reduce((a,b)=>a+b,0)-1)<1e-10))
  }
  const extreme=stationEcology({temp:20,precip:3000,slope:0,relief:0,cover:{...Object.fromEntries(Object.keys(cover).map(key=>[key,0])),林地:1}})
  assert.ok(extreme.eei>100)
  assert.match(report.modelCard.eeiRange,/无固定 100/)
  const empty=await evaluateEcology(scratch,new URLSearchParams({scope:'bbox',bbox:'80,20,81,21',year:'2025'}))
  assert.equal(empty.summary.means,null);assert.equal(empty.summary.count,0)
  await save('stations.json',{stations:[{...stations[0],lc:{}}]})
  const noCover=await evaluateEcology(scratch,new URLSearchParams({year:'2025'}))
  assert.equal(noCover.summary.means,null)
  await save('stations.json',{stations})
  await assert.rejects(()=>evaluateEcology(scratch,new URLSearchParams({scope:'bbox',bbox:'103,30,99,20'})),/无效/)
  await assert.rejects(()=>evaluateEcology(scratch,new URLSearchParams({year:'2026'})),/档案/)
  const annualRecord={year:2025,value:.5,coverageKm2:50,allYearsCommon:{value:.4,coverageKm2:20,validPixels:20}}
  await save('ecology/rsei-support.json',{source:'fixture',version:'test',rasterSources:[{year:2025}],regions:{'subbasin:1':{id:'subbasin:1',areaKm2:100,records:[annualRecord]}}})
  assert.equal((await ecologyRseiLayer(scratch,2025)).values['1'],.4)
  assert.equal((await ecologyRseiLayer(scratch,2025,'annual')).values['1'],.5)
  assert.equal((await ecologyRseiLayer(scratch,2025)).coverage['1'],.2)
  await assert.rejects(()=>ecologyRseiLayer(scratch,2025,'invalid'),/掩膜/)
  console.log('Verified empirical-score limits, six sensitivity cases, empty scope, paired comparisons, run integrity, exports and RSEI mask consistency.')
} finally {
  assert.equal(dirname(resolve(scratch)),resolve(tmpdir()))
  await rm(scratch,{recursive:true,force:true})
}
