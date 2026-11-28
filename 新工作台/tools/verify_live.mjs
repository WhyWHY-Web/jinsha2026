import assert from 'node:assert/strict'
import { mkdtemp,mkdir,writeFile,rm,readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname,join,resolve } from 'node:path'
import { createLiveService,parseForecast,parseGhcn } from '../server/live.ts'
import { forecastDays,forecastUsable } from '../server/forecast-model.ts'
import { forecastEvidence,verifySaved } from '../src/saved-runs.ts'

const now=Date.now(),date=new Date(now).toISOString().slice(0,10),station={id:'test',name:'fixture',lon:100,lat:28,elev:2000}
const grid={latitude:28,longitude:100,elevation:1990,utc_offset_seconds:0,hourly_units:{temperature_2m:'°C',relative_humidity_2m:'%',precipitation:'mm',et0_fao_evapotranspiration:'mm',vapour_pressure_deficit:'kPa'},hourly:{
  time:Array.from({length:168},(_,i)=>new Date(Date.parse(date+'T00:00Z')+i*3600000).toISOString().slice(0,16)),
  temperature_2m:Array(168).fill(15),relative_humidity_2m:Array(168).fill(60),precipitation:Array(168).fill(0),
  et0_fao_evapotranspiration:Array(168).fill(.1),vapour_pressure_deficit:Array(168).fill(.8),
}}
const snapshot=parseForecast(grid,[station],new Date(now).toISOString())
assert.equal(snapshot.issuedAt,null)
assert.equal(snapshot.stations[0].hours.length,168)
assert.equal(snapshot.stations[0].hours[0].precipitation,0)
assert.equal(forecastUsable(snapshot,now),true)
assert.equal(forecastUsable(snapshot,now+13*3600000),false)
const full=await forecastEvidence(snapshot,{scope:'basin',bbox:'',day:''},'http://localhost:8732/?scene=forecast')
const single=await forecastEvidence(snapshot,{scope:'station:test',bbox:'',day:''},'http://localhost:8732/?scene=forecast&station=test')
assert.notEqual(full.id,single.id)
assert.equal(await verifySaved(full),true)
const altered=structuredClone(full);altered.selection.scope='station:other'
assert.equal(await verifySaved(altered),false)
const days=forecastDays(snapshot.stations[0],Date.parse(date+'T00:00Z'))
assert.equal(days.reduce((sum,row)=>sum+row.hours,0),168)
assert.ok(days.every(row=>row.precipitation===0 && row.balance<0))
const missing=structuredClone(snapshot.stations[0]);missing.hours[0].et0=null
assert.equal(forecastDays(missing,Date.parse(date+'T00:00Z'))[0].balance,null)
const bad=structuredClone(grid);bad.hourly_units.precipitation='in'
assert.throws(()=>parseForecast(bad,[station],new Date(now).toISOString()),/单位/)
const gap=structuredClone(grid);gap.hourly.time[3]=gap.hourly.time[4]
assert.throws(()=>parseForecast(gap,[station],new Date(now).toISOString()),/连续/)

const id='CHM00056004'
function line(element,values) {
  return id+'202501'+element+Array.from({length:31},(_,i)=>{
    const entry=values[i+1] ?? [-9999,' ']
    return String(entry[0]).padStart(5)+' '+entry[1]+' '
  }).join('')
}
const raw=[line('PRCP',{1:[0,' '],2:[123,'X']}),line('TAVG',{1:[123,' ']})].join('\n')
const parsed=parseGhcn(raw,id,'2025-01-01')
assert.equal(parsed.latest.PRCP.value,0)
assert.equal(parsed.latest.TAVG.value,12.3)
assert.equal(parsed.qualityRejected,1)
assert.equal(parsed.recent.length,2)
assert.throws(()=>parseGhcn(raw.replace(id,'USW00000000'),id,'2025'),/站号/)

const scratch=await mkdtemp(join(tmpdir(),'jinsha-live-test-'))
const originalFetch=globalThis.fetch,originalNow=Date.now,originalMode=process.env.JINSHA_LIVE_UPDATES
let service,restarted,requests=0
try {
  process.env.JINSHA_LIVE_UPDATES='off'
  for(const folder of ['data/ghcn','source','runtime'])await mkdir(join(scratch,folder),{recursive:true})
  await writeFile(join(scratch,'source/stations.json'),JSON.stringify({stations:[station]}))
  await writeFile(join(scratch,'data/ghcn/manifest.json'),JSON.stringify({stations:[{stationId:id,name:'fixture',lon:100,lat:28,elevation_m:2000}]}))
  globalThis.fetch=async url=>{requests++;return String(url).includes('open-meteo')?Response.json(grid):new Response(raw)}
  service=createLiveService(join(scratch,'data'),join(scratch,'source'),join(scratch,'runtime'))
  const first=service.refresh(true),duplicate=service.refresh(true)
  assert.equal(first,duplicate)
  await first
  assert.equal(requests,2)
  const before=await service.forecast(),success=(await service.status()).sources[0].lastSuccessAt
  assert.equal((await service.status()).sources[1].observedAt,'2025-01-01')
  assert.equal((await service.status()).sources[1].state,'delayed')
  Date.now=()=>now+61000
  globalThis.fetch=async url=>{if(String(url).includes('open-meteo'))return Response.json(bad);throw new Error('injected offline')}
  await service.refresh(true)
  assert.deepEqual(await service.forecast(),before)
  const status=await service.status()
  assert.equal(status.sources[0].state,'invalid')
  assert.equal(status.sources[0].lastSuccessAt,success)
  assert.equal(status.sources[1].state,'failed')
  assert.equal(status.sources[1].observedAt,'2025-01-01')
  assert.equal((await service.observations()).stations[0].latest.TAVG.value,12.3)
  assert.ok((await readdir(join(scratch,'runtime'))).every(file=>!file.endsWith('.tmp')))
  restarted=createLiveService(join(scratch,'data'),join(scratch,'source'),join(scratch,'runtime'))
  assert.equal((await restarted.forecast()).id,before.id)
  assert.equal(await restarted.forecast('a'.repeat(24)),null)
  console.log('Verified forecast units, valid periods, missing/zero values, NOAA quality flags, single-flight updates, failure isolation and restart recovery.')
} finally {
  service?.close();restarted?.close();globalThis.fetch=originalFetch;Date.now=originalNow
  if(originalMode===undefined)delete process.env.JINSHA_LIVE_UPDATES;else process.env.JINSHA_LIVE_UPDATES=originalMode
  assert.equal(dirname(resolve(scratch)),resolve(tmpdir()))
  await rm(scratch,{recursive:true,force:true})
}
