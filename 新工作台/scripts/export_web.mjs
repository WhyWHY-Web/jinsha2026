import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const workbench = fileURLToPath(new URL('../',import.meta.url))
const { values } = parseArgs({options:{output:{type:'string'},origin:{type:'string'},source:{type:'string'}}})
const output = resolve(values.output || join(workbench,'releases','web-'+new Date().toISOString().replace(/[:.]/g,'-')))
const origin = new URL(values.origin || 'http://127.0.0.1:8732')
if (origin.protocol!=='http:' || !['127.0.0.1','localhost'].includes(origin.hostname) || origin.username || origin.password) {
  throw new Error('The export source must be the local workbench API')
}
const source = values.source ? resolve(values.source,'data') : fileURLToPath(new URL('../../系统/data/',import.meta.url))
const data = join(workbench,'data')
const snapshot = join(output,'snapshot')
const runtime = join(output,'runtime')

async function exists(path) { return stat(path).catch(()=>null) }
async function save(path,payload) {
  await mkdir(dirname(path),{recursive:true})
  await writeFile(path,payload)
}
const saveJson = (name,content) => save(join(snapshot,name),JSON.stringify(content))
const readJson = async path => JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''))
async function copyFile(from,...segments) {
  const target=join(output,...segments)
  await mkdir(dirname(target),{recursive:true})
  await cp(from,target)
}

async function endpoint(route) {
  const response=await fetch(new URL('/api/'+route,origin),{signal:AbortSignal.timeout(15000)})
  if (!response.ok) throw new Error('Local API '+route+' returned '+response.status+'. Start the latest workbench first.')
  return response.json()
}

async function browserModule(name, substitutions) {
  let code=await readFile(join(workbench,'server',name+'.ts'),'utf8')
  for (const [input,replacement] of substitutions) code=code.replaceAll(input,replacement)
  code=stripTypeScriptTypes(code).split('\n').map(line=>line.trimEnd()).join('\n')
  if (/from\s*['"]node:|process\.env|from\s*['"][^'"\n]*\.ts['"]/u.test(code)) {
    throw new Error('Browser module '+name+' contains unsupported platform imports')
  }
  await save(join(runtime,name+'.js'),code)
}

async function copyTerrarium(input, outputLayer, predicate) {
  for (const zoom of await readdir(input, {withFileTypes:true})) {
    if (!zoom.isDirectory() || !/^\d{1,2}$/.test(zoom.name) || !predicate(Number(zoom.name))) continue
    for (const x of await readdir(join(input,zoom.name),{withFileTypes:true})) {
      if (!x.isDirectory() || !/^\d+$/.test(x.name)) continue
      for (const file of await readdir(join(input,zoom.name,x.name),{withFileTypes:true})) {
        if (!file.isFile() || !/^\d+\.png$/.test(file.name)) continue
        await copyFile(join(input,zoom.name,x.name,file.name),'assets','source',outputLayer,zoom.name,x.name,file.name)
      }
    }
  }
}

async function bundleSeries(stations) {
  const rawAnnual=await readJson(join(source,'climate_annual.json'))
  const metrics = ['ndvi','temperature','precipitation','evapotranspiration','discharge','rsei']
  const series = {}
  const jobs = ['' , ...stations.map(row=>row.id)].flatMap(station=>metrics.map(metric=>[station,metric]))
  for (let i=0;i<jobs.length;i+=12) {
    await Promise.all(jobs.slice(i,i+12).map(async ([station,metric])=>{
      const query=new URLSearchParams({metric,...(station?{station}:{})})
      const result=await endpoint('series?'+query)
      if(station && ['temperature','precipitation'].includes(metric)) {
        const name=stations.find(row=>row.id===station)?.name
        const field=metric==='temperature'?'temp_c':'precip_mm'
        result.values=rawAnnual.filter(row=>row.station===name).map(row=>({year:row.year,value:row[field]})).sort((a,b)=>a.year-b.year)
        result.source='NASA POWER MERRA-2 · 公开基准档案'
      }
      series[station.toLowerCase()+'|'+metric] = result
    }))
  }
  await saveJson('api/series.json',series)
}

async function bundleArchives() {
  const ids = new Set()
  for (const directory of ['ghcn','precipitation','landcover','scientific']) {
    const manifest = await readJson(join(data,directory,'manifest.json'))
    if (!/^[a-zA-Z0-9_-]+$/.test(manifest.id) || !manifest.file.endsWith('.csv.gz') || basename(manifest.file)!==manifest.file) {
      throw new Error('Invalid public archive manifest in '+directory)
    }
    await copyFile(join(data,directory,manifest.file),'snapshot','archives',manifest.id+'.csv.gz')
    ids.add(manifest.id)
  }
  return ids
}

async function compileUi() {
  const vite=join(workbench,'node_modules','vite','bin','vite.js')
  const build=spawnSync(process.execPath,[vite,'build','--base','./','--outDir',output],{cwd:workbench,stdio:'inherit'})
  if (build.status!==0) throw new Error('Vite public build failed')
  const path=join(output,'index.html')
  const markup=await readFile(path,'utf8')
  const script=/<script\b[^>]*type="module"[^>]*src="([^"]+)"[^>]*><\/script>/u.exec(markup)
  if (!script || !script[1].startsWith('./assets/')) throw new Error('Public app needs a relative generated entry URL')
  const start=`document.documentElement.dataset.jinshaMode = 'public';\nawait import('./public-api.js');\nawait import(${JSON.stringify('../'+script[1].slice(2))});\n`
  await save(join(runtime,'start.js'),start)
  await writeFile(path,markup.replace(script[0],'<script type="module" src="./runtime/start.js"></script>'))
}

if (await exists(output)) {
  if ((await readdir(output)).length) throw new Error('Choose an empty output directory: '+output)
} else await mkdir(output,{recursive:true})

// Never export workspace state. Every file in the deployment is named below.
const [dashboard,catalog,science,options] = await Promise.all([
  endpoint('dashboard'), endpoint('catalog'), endpoint('scientific'), endpoint('ecology/options'),
])
if (!science.archive?.rows || !options.scenarios?.length) throw new Error('Local ecological or soil services are incomplete')
await compileUi()

const publicMap=dashboard.map
publicMap.fallbackImageUrl='/assets/source/blue-marble.webp'
publicMap.imagerySource='NASA Blue Marble · GIBS'
delete publicMap.imageryUrl
delete publicMap.lowResolutionImageUrl
await copyFile(join(data,'public-map','blue-marble.webp'),'assets','source','blue-marble.webp')
if (publicMap.context) await copyFile(join(data,'map-context','relief.webp'),'assets','source','context-relief.webp')
await copyTerrarium(join(data,'terrain'),'terrain',z=>z>=5&&z<=9)
const zoom10=await exists(join(source,'tiles_dem','10'))
if (zoom10?.isDirectory()) await copyTerrarium(join(source,'tiles_dem'),'terrain',z=>z===10)
else publicMap.terrainMaxZoom=9
if (publicMap.regionalTerrain) await copyTerrarium(join(data,'regional-dem'),'regional-dem',z=>z>=5&&z<=7)
const publicArchiveIds=await bundleArchives()
const visibleCatalog=catalog.datasets.filter(item=>!item.queryable||publicArchiveIds.has(item.id))
dashboard.catalog=visibleCatalog

await Promise.all([
  saveJson('api/dashboard.json',dashboard),saveJson('api/catalog.json',{datasets:visibleCatalog}),saveJson('api/scientific.json',science),
  bundleSeries(dashboard.stations),
  ...['engineering','water-quality','flood/replay'].map(async route=>saveJson('api/'+route+'.json',await endpoint(route))),
  ...['live/forecast','live/observations'].map(async route=>saveJson('api/'+route+'.json',await endpoint(route))),
  (async()=>{const status=await endpoint('live/status');await saveJson('api/live/status.json',{...status,mode:'snapshot',collecting:false,
    sources:status.sources.map(source=>({...source,nextCheckAt:null,state:source.state==='fresh'?'offline':source.state}))})})(),
  ...['basin','river-network',...(publicMap.expandedRiverUrl?['expanded-rivers']:[])].map(async name=>{
    const route='layers/'+name+(name==='expanded-rivers'?'?detail=major':'')
    await saveJson('map/'+name+'.geojson',await endpoint(route))
  }),
  copyFile(join(data,'ecology','rsei-support.json'),'snapshot','derived','ecology','rsei-support.json'),
  copyFile(join(data,'scientific','profiles.json'),'snapshot','derived','scientific','profiles.json'),
  copyFile(join(data,'flood','glofas-daily.json.gz'),'snapshot','derived','flood','glofas-daily.json.gz'),
  copyFile(join(data,'scientific','manifest.json'),'snapshot','derived','scientific','manifest.json'),
])

const allowStation = ['id','name','en','lon','lat','zone','type','elev','slope','relief','temp','precip','lc','lcSrc','climSrc','elevSrc']
const pick = (object,keys)=>Object.fromEntries(keys.filter(key=>Object.hasOwn(object,key)).map(key=>[key,object[key]]))
const rawStations=await readJson(join(source,'stations.json'))
const rawClimate=await readJson(join(source,'climate.json'))
const rawNdvi=await readJson(join(source,'gee','annual.json'))
await Promise.all([
  saveJson('source/stations.json',{stations:rawStations.stations.map(row=>pick(row,allowStation))}),
  saveJson('source/climate.json',{stations:Object.fromEntries(Object.entries(rawClimate.stations ?? {}).map(([key,value])=>[key,{years:value.years}]))}),
  saveJson('source/climate_annual.json',(await readJson(join(source,'climate_annual.json'))).map(row=>pick(row,['station','year','temp_c','precip_mm','source']))),
  saveJson('source/climate_monthly.json',(await readJson(join(source,'climate_monthly.json'))).map(row=>pick(row,['station','year','month','precip_mm']))),
  saveJson('source/gee/annual.json',{ndvi:rawNdvi.ndvi}),
  saveJson('source/rsei/rsei_all.json',await readJson(join(source,'rsei','rsei_all.json'))),
  saveJson('source/basin/jinsha_basin.geojson',await readJson(join(source,'basin','jinsha_basin.geojson'))),
])

for (const name of ['public-api.js','snapshot-io.js']) await copyFile(join(workbench,'public-export',name),'runtime',name)
const browserIo = [['node:fs/promises','./snapshot-io.js'],['node:path','./snapshot-io.js']]
await browserModule('ecology',browserIo)
await browserModule('forecast-model',[])
await browserModule('scientific',browserIo)
await browserModule('agent',[
  ['./ecology.ts','./ecology.js'],['./scientific.ts','./scientific.js'],['./workflow.ts','./snapshot-io.js'],
  [/process\.env\.JINSHA_AGENT_MODEL\s*\?\?\s*"[^"]+"/g,'"off"'],
])
await save(join(output,'.nojekyll'),'')
const sourceFiles=['package.json','package-lock.json','server/ecology.ts','server/agent.ts','server/forecast-model.ts',
  ...(await readdir(join(workbench,'src'),{withFileTypes:true})).filter(entry=>entry.isFile()).map(entry=>'src/'+entry.name)]
const sourceHashes=Object.fromEntries(await Promise.all(sourceFiles.map(async file=>[file,createHash('sha256').update(await readFile(join(workbench,file))).digest('hex')])))
const commit=spawnSync('git',['rev-parse','HEAD'],{cwd:workbench,encoding:'utf8'})
await save(join(output,'RELEASE.json'),JSON.stringify({product:'金沙江生态研究工作台',version:(await readJson(join(workbench,'package.json'))).version,
  mode:'read-only-snapshot',builtAt:new Date().toISOString(),gitCommit:commit.status===0?commit.stdout.trim():null,sourceHashes},null,2))
await save(join(output,'SOURCES.txt'),['Satellite base: NASA EOSDIS GIBS, BlueMarble_ShadedRelief_Bathymetry (Visible Earth).',
  'Coverage: 97.6 E to 105.4 E; 25.9 N to 32.5 N. WMS Web Mercator subset; feathered edges.',
  'Relief: USGS SRTM / Mapzen Terrain Tiles, plus the project published Terrarium DEM.',
  'Soil: ISRIC SoilGrids v2.0, CC BY 4.0; land cover: ESA WorldCover v200, CC BY 4.0.',
  'HydroRIVERS: WWF and HydroSHEDS, open data terms. https://www.hydrosheds.org/products/hydrorivers',
  'Additional data provenance and links: ./snapshot/api/catalog.json',
].join('\n')+'\n')
console.log('Public read-only snapshot: '+output)
