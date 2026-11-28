import { ecologyOptions, ecologyRsei, ecologyRseiLayer, evaluateEcology } from './ecology.js'
import { runEcologyAgent } from './agent.js'
import { readFile } from './snapshot-io.js'
import { forecastUsable } from './forecast-model.js'

const address = new URL('../', import.meta.url)
const dataRoot = new URL('snapshot/', address)
const apiRoot = new URL('snapshot/api/', address)
const originalFetch = window.fetch.bind(window)
const sourceData = 'source'
const newData = 'derived'
const emptyOverrides = () => ({})
const staticApis = new Set(['dashboard','catalog','engineering','water-quality','flood/replay','live/observations'])
const geography = {
  '/api/layers/basin':'basin.geojson',
  '/api/layers/river-network':'river-network.geojson',
  '/api/layers/expanded-rivers':'expanded-rivers.geojson',
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {status,headers:{'Content-Type':'application/json; charset=utf-8'}})
}

const error = (message,status) => json({error:message},status)
const read = async path => JSON.parse(await readFile(path))
const dashboard = () => read('api/dashboard.json')
const apiFile = (path, signal) => originalFetch(new URL(path+'.json',apiRoot),{signal})
const publicFile = path => new URL(path,address).href

function replaceMapPaths(value) {
  if (typeof value === 'string') {
    const url = value.split('?',1)[0]
    if (Object.hasOwn(geography,url)) return publicFile('snapshot/map/'+geography[url])
    if (value.startsWith('/assets/source/')) return address.href+value.slice(1)
    return value
  }
  if (Array.isArray(value)) return value.map(replaceMapPaths)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,replaceMapPaths(item)]))
}

function splitCsv(line) {
  const fields = []
  let field = '', quoted = false
  for (let i=0;i<line.length;i++) {
    const next=line[i]
    if (next==='"') {
      if (quoted && line[i+1]==='"') { field+='"'; i++ }
      else quoted=!quoted
    } else if (next===',' && !quoted) { fields.push(field); field='' }
    else field+=next
  }
  fields.push(field)
  return fields
}

async function archivePage(id, params, signal) {
  const catalog = await read('api/catalog.json')
  const archive = catalog.datasets.find(item=>item.id===id && item.queryable)
  if (!archive) return error('未找到数据集',404)
  const limit = Number(params.get('limit') ?? 24)
  const offset = Number(params.get('offset') ?? 0)
  const year = params.get('year') || ''
  const query = (params.get('q') || '').trim().toLowerCase().slice(0,120)
  if (!Number.isInteger(limit) || limit<1 || limit>100 || !Number.isInteger(offset) || offset<0 || offset>1000000
    || year && !/^\d{4}$/.test(year)) return error('请检查年份或分页参数',400)
  const response = await originalFetch(new URL('archives/'+id+'.csv.gz',dataRoot),{signal})
  if (!response.ok || !response.body) return error('该数据包暂不可用',503)
  const stream = response.body.pipeThrough(new DecompressionStream('gzip')).pipeThrough(new TextDecoderStream())
  const reader = stream.getReader()
  let fragment='', columns = [], dateIndex=-1, matches=0
  const rows=[]
  try {
    for (;;) {
      const {done,value} = await reader.read()
      const pieces = (fragment+(value ?? '')).split('\n')
      fragment = done ? '' : pieces.pop()
      for (const raw of pieces) {
        signal?.throwIfAborted()
        const line=raw.replace(/\r$/,'')
        if (!columns.length) {
          columns=splitCsv(line.replace(/^\uFEFF/,''))
          dateIndex=columns.findIndex(column=>['date','year','month'].includes(column.toLowerCase()))
          continue
        }
        if (!line || query && !line.toLowerCase().includes(query)) continue
        const row=splitCsv(line)
        if (row.length !== columns.length || year && (dateIndex<0 ? String(archive.startYear)!==year : row[dateIndex].slice(0,4)!==year)) continue
        if (matches++<offset) continue
        if (rows.length===limit) return json({archive,columns,rows,nextOffset:offset+limit})
        rows.push(row)
      }
      if (done) return json({archive,columns,rows,nextOffset:null})
    }
  } finally {
    await reader.cancel().catch(()=>{})
  }
}

async function readScience(basin) {
  const source = await read('api/scientific.json')
  if (!basin) return json(source)
  const available = source.basins.find(item=>item.id===basin)
  if (!available) return error('该范围没有可用的土壤档案',404)
  const profiles = await read('derived/scientific/profiles.json')
  return json({...source,scope:{kind:'subbasin',id:basin},profiles:profiles.subbasins[basin]})
}

async function browserAgent(body) {
  if (typeof body?.prompt!=='string' || !body.prompt.trim() || body.prompt.length>700) return error('请使用 1–700 个字符输入问题',400)
  if (/修正|更正|改为|设为|校正|编辑|补录|调整.*(?:为|到)/u.test(body.prompt)) {
    return json({mode:'local',answer:'公开版提供查询和评估。数据修正入口位于本机工作台。',evidence:[]})
  }
  const { stations } = await dashboard()
  const reply = await runEcologyAgent(body,{sourceData,newData,stations,overrides:emptyOverrides})
  const evidence = reply.evidence.map(item=>{
    if (item.url==='/api/catalog') return {...item,url:publicFile('snapshot/api/catalog.json')}
    if (item.url?.startsWith('/api/')) {
      const {url,...localEvidence} = item
      return localEvidence
    }
    return item
  })
  return json({...reply,evidence})
}

async function route(url, method, body, signal) {
  const key=url.pathname.slice('/api/'.length)
  const params=url.searchParams
  if (method==='POST' && key==='ecology/agent') return browserAgent(body)
  if (method!=='GET' && method!=='HEAD') return error('公开工作台提供只读访问',405)
  if (key==='dashboard') {
    const data = await dashboard()
    return json({...data,map:replaceMapPaths(data.map)})
  }
  if(key==='live/status') {
    const [status,forecast]=await Promise.all([read('api/live/status.json'),read('api/live/forecast.json')])
    return json({...status,mode:'snapshot',collecting:false,sources:status.sources.map(source=>({
      ...source,state:source.id==='forecast' && forecast.snapshot && !forecastUsable(forecast.snapshot) && ['fresh','offline'].includes(source.state)?'delayed':source.state,
    }))})
  }
  if(key==='live/forecast') {
    const value=await read('api/live/forecast.json')
    const snapshot=params.get('batch') && params.get('batch')!==value.snapshot?.id ? null : value.snapshot
    const usable=!!snapshot && forecastUsable(snapshot)
    const sourceStatus=value.sourceStatus ? {...value.sourceStatus,nextCheckAt:null,
      state:['fresh','offline'].includes(value.sourceStatus.state)?usable?'offline':'delayed':value.sourceStatus.state,
      detail:'发布时资料快照；更新需要重新导出。'+value.sourceStatus.detail} : undefined
    return json({...value,snapshot,usable,sourceStatus})
  }
  if (staticApis.has(key)) return apiFile(key,signal)
  if (key==='health') return json({ok:true,service:'jinsha-workbench',engine:'browser',mode:'public'})
  if (Object.hasOwn(geography,url.pathname)) return originalFetch(new URL('map/'+geography[url.pathname],dataRoot),{signal})
  if (key==='ecology/options') return json(await ecologyOptions(sourceData))
  if (key==='ecology/assess') return json(await evaluateEcology(sourceData,params))
  if (key==='ecology/rsei') return json(await ecologyRsei(sourceData,newData,params.get('scope') ?? 'basin'))
  if (key==='layers/rsei') return json(await ecologyRseiLayer(newData,Number(params.get('year')),params.get('mask') ?? 'common'))
  if (key==='ecology/amendments') return json({revision:0,entries:[],amendments:[],readOnly:true})
  if (key==='scientific') return readScience(params.get('basin'))
  if (key==='flood/series') {
    const year=params.get('year') || ''
    const id=params.get('station') || ''
    if (!id || !/^\d{4}$/.test(year)) return error('请提供站点和四位年份',400)
    const metadata=await read('api/flood/replay.json')
    const index=metadata.stations.findIndex(station=>station.id===id)
    if (index<0) return error('未找到该站点的日流量档案',404)
    const response=await originalFetch(new URL('derived/flood/glofas-daily.json.gz',dataRoot),{signal})
    if (!response.ok || !response.body) return error('日流量档案暂不可用',503)
    const unzipped = new Response(response.body.pipeThrough(new DecompressionStream('gzip')))
    const grids=await unzipped.json()
    const { time, river_discharge }=grids[index].daily
    const rows=time.flatMap((date,i)=>date.startsWith(year+'-') ? [{date,value:river_discharge[i]}] : [])
    return json({station:metadata.stations[index],year:Number(year),source:metadata.source,sourceUrl:metadata.sourceUrl,unit:'m³/s',rows})
  }
  if (key==='stations') {
    const data = await dashboard()
    const query=(params.get('q') || '').trim().toLowerCase()
    return json({stations:data.stations.filter(row=>!query || [row.name,row.en,row.id,row.zone].some(value=>value?.toLowerCase().includes(query)))})
  }
  if (key==='series') {
    const lookup=await read('api/series.json')
    const slot=(params.get('station') || '').trim().toLowerCase()+'|'+(params.get('metric') || 'ndvi').trim().toLowerCase()
    const series=lookup[slot]
    const from=params.get('from'), to=params.get('to')
    if ([from,to].some(year=>year!=null && !/^\d{4}$/.test(year)) || from&&to&&Number(from)>Number(to)) return error('无效的年份区间',400)
    if (!series) return error('未找到时序或站点',404)
    return json({...series,values:series.values.filter(row=>(!from||row.year>=Number(from))&&(!to||row.year<=Number(to)))})
  }
  if (key==='climate/months') {
    const year=params.get('year') || ''
    if (!/^\d{4}$/.test(year)) return error('请输入四位年份',400)
    const {stations}=await dashboard()
    const id=params.get('station') || ''
    const station=stations.find(row=>row.id===id)
    if (id&&!station) return error('未找到站点',404)
    const scope=station?.name || '流域面平均'
    const records=await read('source/climate_monthly.json')
    const rows=records.filter(row=>row.station===scope&&row.year===Number(year))
      .sort((a,b)=>a.month-b.month).map(row=>({month:row.month,value:row.precip_mm}))
    return json({rows,scope,source:'NASA POWER · MERRA-2',unit:'mm'})
  }
  if (key==='layers/ndvi') {
    const year=params.get('year') || ''
    if (!/^\d{4}$/.test(year) || Number(year)<1000) return error('请选择 NDVI 档案年份',400)
    const [{ stations }, { ndvi }]=await Promise.all([dashboard(),read('source/gee/annual.json')])
    const values=Object.fromEntries(stations.flatMap(station=>{
      const point=ndvi[station.name]?.find(([label])=>Number(label)===Number(year))
      return Number.isFinite(point?.[1]) ? [[station.id,point[1]]] : []
    }))
    return json({year:Number(year),values,source:'MODIS MOD13Q1 · 站点缓冲区'})
  }
  const archive=/^archives\/([a-zA-Z0-9_-]+)$/.exec(key)
  if (archive) return archivePage(archive[1],params,signal)
  return error('此公开数据快照没有该接口',404)
}

window.fetch = async (input, init) => {
  const url=new URL(input instanceof Request ? input.url : input,document.baseURI)
  if (url.origin!==location.origin || !url.pathname.startsWith('/api/')) return originalFetch(input,init)
  const method=(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  const signal=init?.signal ?? (input instanceof Request ? input.signal : undefined)
  try {
    signal?.throwIfAborted()
    const body=method==='POST' ? (typeof init?.body==='string' ? JSON.parse(init.body) : input instanceof Request ? await input.clone().json() : {}) : null
    const response=await route(url,method,body,signal)
    signal?.throwIfAborted()
    return method==='HEAD' ? new Response(null,{status:response.status,headers:response.headers}) : response
  } catch (failure) {
    signal?.throwIfAborted()
    return failure instanceof SyntaxError ? error('请求格式不正确',400)
      : failure.status ? error(failure.message,failure.status) : error('公开数据快照暂不可用',503)
  }
}
