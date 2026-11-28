import { createHash } from 'node:crypto'
import { mkdir,readFile,rename,writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ForecastSnapshot,ForecastStation,LiveStatus,ObservationSnapshot,ObservationStation,SourceStatus } from './live-types.ts'
import { forecastUsable } from './forecast-model.ts'

type Station = {id:string;name:string;lon:number;lat:number;elev?:number}
type GhcnStation = {stationId:string;name:string;lon:number;lat:number;elevation_m:number;lastDate:string}
const forecastSource='https://open-meteo.com/en/docs'
const noaaSource='https://www.ncei.noaa.gov/products/land-based-station/global-historical-climatology-network-daily'
const checksum=(text:string)=>createHash('sha256').update(text).digest('hex')
const iso=()=>new Date().toISOString()
const empty=(id:string,label:string,source:string,url:string,kind:string,version:string,hours:number):SourceStatus=>({
  id,label,source,sourceUrl:url,kind,version,observedAt:null,issuedAt:null,retrievedAt:null,lastSuccessAt:null,
  lastAttemptAt:null,nextCheckAt:null,staleAfterHours:hours,validFrom:null,validTo:null,state:'missing',
  detail:'尚未获取有效资料',coverage:null,contentHash:null,
})
async function optional<T>(file:string):Promise<T|null> {
  try {return JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/,''))}
  catch (error) {if ((error as NodeJS.ErrnoException).code!=='ENOENT') console.warn('运行资料无法读取：'+file);return null}
}
async function atomic(file:string,value:unknown) {
  const temporary=file+'.'+process.pid+'.'+crypto.randomUUID()+'.tmp'
  await writeFile(temporary,JSON.stringify(value));await rename(temporary,file)
}
async function fetchText(url:URL|string,limit:number) {
  let failure:unknown
  for (let attempt=0;attempt<2;attempt++) {
    try {
      const response=await fetch(url,{signal:AbortSignal.timeout(20_000),headers:{'User-Agent':'JinshaWorkbench/0.3 research contact via project repository'}})
      if (!response.ok) throw new Error('来源返回 HTTP '+response.status)
      if (Number(response.headers.get('content-length'))>limit) throw new Error('来源响应超过大小限制')
      if (!response.body) throw new Error('来源响应为空')
      const reader=response.body.getReader();const chunks:Uint8Array[]=[];let length=0
      try {
        for (;;) {const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>limit)throw new Error('来源响应超过大小限制');chunks.push(value)}
      } finally {await reader.cancel().catch(()=>{})}
      return Buffer.concat(chunks).toString('utf8')
    } catch (error) {failure=error}
  }
  throw failure
}

export function parseGhcn(text:string,id:string,cutoff:string) {
  const latest:ObservationStation['latest']={};const recent:ObservationStation['recent']=[];let qualityRejected=0
  const units:Record<string,[string,number]>={PRCP:['mm',.1],TAVG:['°C',.1],TMAX:['°C',.1],TMIN:['°C',.1],SNWD:['mm',1]}
  let records=0
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue
    if (line.length!==269 || line.slice(0,11)!==id || !/^\d{6}$/.test(line.slice(11,17))) throw new Error('NOAA 固定宽度或站号校验失败')
    const element=line.slice(17,21);if (!units[element])continue
    const year=Number(line.slice(11,15)),month=Number(line.slice(15,17))
    if(year<1800 || year>new Date().getUTCFullYear() || month<1 || month>12)throw new Error('NOAA 年月校验失败')
    const days=new Date(Date.UTC(year,month,0)).getUTCDate()
    for(let day=1;day<=days;day++) {
      const start=21+(day-1)*8,raw=line.slice(start,start+5),flag=line[start+6]
      if(!/^ *-?\d+$/.test(raw))throw new Error('NOAA 数值格式校验失败')
      const value=Number(raw);if(value===-9999)continue
      const date=`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`
      if(flag!==' ') {if(date>=cutoff)qualityRejected++;continue}
      const [unit,scale]=units[element],normalized=Number((value*scale).toFixed(1))
      if((unit==='°C' && (normalized < -90 || normalized>65)) || (unit==='mm' && (normalized<0 || normalized>12000)))throw new Error('NOAA 数值范围校验失败')
      records++
      if(!latest[element] || date>latest[element].date)latest[element]={date,value:normalized,unit}
      if(date>=cutoff)recent.push({date,element,value:normalized,unit})
    }
  }
  if(!records)throw new Error('NOAA 未返回有效记录')
  return {latest,recent,qualityRejected,observedAt:Object.values(latest).map(row=>row.date).sort().at(-1) ?? null}
}

export function parseForecast(payload:unknown,stations:Station[],retrievedAt:string):ForecastSnapshot {
  const grids=Array.isArray(payload)?payload:[payload]
  if(grids.length!==stations.length)throw new Error('预报格点数量不匹配')
  const parsed:ForecastStation[]=grids.map((grid,index)=>{
    const station=stations[index]
    if(!grid || typeof grid.latitude!=='number' || typeof grid.longitude!=='number' || Math.abs(grid.latitude-station.lat)>1 || Math.abs(grid.longitude-station.lon)>1)throw new Error('预报格点坐标校验失败')
    const hourly=grid.hourly,units=grid.hourly_units
    if(!hourly || !Array.isArray(hourly.time) || hourly.time.length<24 || hourly.time.length>192)throw new Error('预报时段不完整')
    const fields=[['temperature','temperature_2m',-90,65,'°C'],['humidity','relative_humidity_2m',0,100,'%'],
      ['precipitation','precipitation',0,1000,'mm'],['et0','et0_fao_evapotranspiration',0,50,'mm'],['vpd','vapour_pressure_deficit',0,20,'kPa']] as const
    if(grid.utc_offset_seconds!==0 || fields.some(([,key,,,unit])=>units?.[key]!==unit || !Array.isArray(hourly[key]) || hourly[key].length!==hourly.time.length))throw new Error('预报单位或时间基准校验失败')
    const hours=hourly.time.map((time:unknown,i:number)=>{
      if(typeof time!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:00$/.test(time))throw new Error('预报时间格式校验失败')
      const timestamp=Date.parse(time+'Z')
      if(!Number.isFinite(timestamp) || (i && timestamp-Date.parse(hourly.time[i-1]+'Z')!==3_600_000))throw new Error('预报时间不连续')
      const row:Record<string,number|null|string>={time:time+'Z'}
      for(const [name,key,low,high] of fields) {
        const value=hourly[key][i]
        if(value!==null && (typeof value!=='number' || !Number.isFinite(value) || value<low || value>high))throw new Error('预报数值范围校验失败')
        row[name]=value
      }
      return row as ForecastStation['hours'][number]
    })
    if(!hours.some((row:ForecastStation['hours'][number])=>row.temperature!==null && row.precipitation!==null))throw new Error('预报必要变量全部缺测')
    return {id:station.id,name:station.name,lon:station.lon,lat:station.lat,elevation:station.elev ?? null,
      grid:{lon:grid.longitude,lat:grid.latitude,elevation:typeof grid.elevation==='number'?grid.elevation:null},hours}
  })
  const validFrom=parsed[0].hours[0].time,validTo=new Date(Date.parse(parsed[0].hours.at(-1)!.time)+3_600_000).toISOString()
  if(Date.parse(validFrom)>Date.parse(retrievedAt)+24*3_600_000 || Date.parse(validTo)<=Date.parse(retrievedAt))throw new Error('来源预报有效期异常')
  const sha256=checksum(JSON.stringify({retrievedAt,stations:parsed}))
  return {id:sha256.slice(0,24),sha256,source:'Open-Meteo',sourceUrl:forecastSource,productVersion:'Forecast API v1 / best_match',
    sourceKind:'model_forecast',issuedAt:null,retrievedAt,validFrom,validTo,modelStatus:'drivers_only',stations:parsed,
    notes:['源接口未提供独立起报时刻；抓取时间不是起报时间。','逐小时格点模型预报，非站点实测；best_match 按位置选择模型，非单一集合。',
      'P−ET₀ 仅为降水与参考蒸散的气象差值，不是土壤水分收支或生态灾害概率。','生态胁迫模型尚未完成地面校准和时间隔离回测；不输出植被死亡、火灾或滑坡发生概率。']}
}

export function createLiveService(dataDir:string,sourceDir:string,runtime:string) {
  let forecast:ForecastSnapshot|null=null,observations:ObservationSnapshot|null=null,pending:Promise<void>|null=null
  let sources:SourceStatus[]=[empty('forecast','未来七天气象','Open-Meteo',forecastSource,'模型预报','v1 / best_match',12),
    empty('ghcn','近期气象观测','NOAA GHCN-Daily',noaaSource,'站点观测','GHCN-Daily v3',72)]
  let history:LiveStatus['history']=[]
  const ready=(async()=>{
    await mkdir(runtime,{recursive:true})
    const seeded=async<T>(name:string)=>await optional<T>(join(runtime,name)) ?? await optional<T>(join(dataDir,'live-seed',name))
    const [saved,f,o]=await Promise.all([seeded<LiveStatus>('status.json'),seeded<ForecastSnapshot>('forecast-latest.json'),seeded<ObservationSnapshot>('observations-latest.json')])
    if(saved?.sources?.length===2){sources=saved.sources;history=saved.history ?? []}
    forecast=f;observations=o
  })()
  async function status():Promise<LiveStatus> {
    await ready
    const views=sources.map(source=>{
      const view={...source}
      if(view.state==='fresh' && ((view.id==='forecast' && (!forecast || !forecastUsable(forecast))) || (view.id==='ghcn' && (!view.observedAt || Date.now()-Date.parse(view.observedAt)>72*3_600_000))))view.state='delayed'
      return view
    })
    return {asOf:iso(),mode:'service',collecting:pending!==null,sources:views,history}
  }
  async function collect(index:number) {
    const source=sources[index],at=iso();source.lastAttemptAt=at
    try {
      if(index===0) {
        const registry=JSON.parse(await readFile(join(sourceDir,'stations.json'),'utf8')).stations as Station[]
        const url=new URL('https://api.open-meteo.com/v1/forecast')
        url.search=new URLSearchParams({latitude:registry.map(s=>s.lat).join(','),longitude:registry.map(s=>s.lon).join(','),
          hourly:'temperature_2m,relative_humidity_2m,precipitation,et0_fao_evapotranspiration,vapour_pressure_deficit',forecast_days:'7',timezone:'UTC',models:'best_match'}).toString()
        const next=parseForecast(JSON.parse(await fetchText(url,4_000_000)),registry,iso())
        await atomic(join(runtime,'forecast-'+next.id+'.json'),next)
        await atomic(join(runtime,'forecast-latest.json'),next);forecast=next
        Object.assign(source,{issuedAt:null,retrievedAt:next.retrievedAt,validFrom:next.validFrom,validTo:next.validTo,contentHash:next.sha256,
          coverage:{valid:next.stations.length,total:registry.length,unit:'研究格点'},state:'fresh',detail:'七天逐小时气象预报；源起报时间未提供；生态压力模型待校准。'})
      } else {
        const manifest=JSON.parse(await readFile(join(dataDir,'ghcn','manifest.json'),'utf8')) as {stations:GhcnStation[]}
        const stations:ObservationStation[]=[];let failures=0
        for(let i=0;i<manifest.stations.length;i+=2) {
          const group=await Promise.all(manifest.stations.slice(i,i+2).map(async station=>{
            if(!/^CH[A-Z0-9]{9}$/.test(station.stationId))throw new Error('NOAA 站号格式无效')
            try {
              const text=await fetchText('https://www.ncei.noaa.gov/pub/data/ghcn/daily/all/'+station.stationId+'.dly',5_000_000)
              const parsed=parseGhcn(text,station.stationId,new Date(Date.now()-45*86_400_000).toISOString().slice(0,10))
              return {id:station.stationId,name:station.name,lon:station.lon,lat:station.lat,elevation:station.elevation_m,
                retrievedAt:iso(),sha256:checksum(text),...parsed}
            } catch(error) {
              failures++
              const old=observations?.stations.find(row=>row.id===station.stationId)
              return old ? {...old,error:String((error as Error).message)} : {id:station.stationId,name:station.name,lon:station.lon,lat:station.lat,elevation:station.elevation_m,
                retrievedAt:at,observedAt:null,sha256:'',qualityRejected:0,latest:{},recent:[],error:String((error as Error).message)}
            }
          }));stations.push(...group)
        }
        if(failures===manifest.stations.length)throw new Error('全部 NOAA 站点采集失败，保留上次有效版本')
        const next:ObservationSnapshot={source:'NOAA GHCN-Daily',sourceUrl:noaaSource,retrievedAt:iso(),stations,
          notes:['各站各变量最新观测分别列示，源端无新数据时不会修改观测时间。','QFLAG 非空及缺测哨兵值已排除；逐站重扫文件以回补近期修订。','NOAA 站网与项目二十个研究站不是同一站网，未自动映射或用于修正 EEI。']}
        await atomic(join(runtime,'observations-latest.json'),next);observations=next
        const observedAt=stations.flatMap(row=>row.observedAt?[row.observedAt]:[]).sort().at(-1) ?? null
        const valid=stations.filter(row=>!row.error && row.observedAt && Date.now()-Date.parse(row.observedAt)<72*3_600_000).length
        Object.assign(source,{retrievedAt:next.retrievedAt,observedAt,coverage:{valid,total:stations.length,unit:'72小时内有观测站'},
          contentHash:checksum(JSON.stringify(next)),state:failures?'failed':valid===stations.length?'fresh':'delayed',
          detail:`${valid}/${stations.length} 站有近三日资料；${failures} 站采集失败。各变量时效需逐站核对。`})
      }
      source.lastSuccessAt=iso();source.nextCheckAt=new Date(Date.now()+(index===0?6:24)*3_600_000).toISOString()
      history=[{at:iso(),source:source.id,ok:source.state!=='failed',detail:source.detail},...history].slice(0,40)
    } catch(error) {
      source.state=/校验|不完整|异常|缺测/.test(String(error))?'invalid':'failed'
      source.detail=String((error as Error).message)+'；上次有效资料仍保留，须核对有效期。'
      source.nextCheckAt=new Date(Date.now()+3_600_000).toISOString()
      history=[{at:iso(),source:source.id,ok:false,detail:source.detail},...history].slice(0,40)
    }
    await atomic(join(runtime,'status.json'),await status())
  }
  function refresh(force=false) {
    if(pending)return pending
    pending=(async()=>{
      await ready
      for(let i=0;i<sources.length;i++) {
        const source=sources[i]
        if(source.lastAttemptAt && Date.now()-Date.parse(source.lastAttemptAt)<60_000)continue
        if(force || !source.nextCheckAt || Date.parse(source.nextCheckAt)<=Date.now())await collect(i)
      }
    })().finally(()=>{pending=null})
    return pending
  }
  const timer=process.env.JINSHA_LIVE_UPDATES==='off'?null:setInterval(()=>{void refresh().catch(error=>console.error('资料采集失败：'+error.message))},60_000)
  timer?.unref()
  if(timer)void refresh().catch(error=>console.error('资料采集初始化失败：'+error.message))
  return {status,refresh,close:()=>{if(timer)clearInterval(timer)},
    forecast:async(batch?:string|null)=>{await ready;return batch && batch!==forecast?.id && /^[a-f0-9]{24}$/.test(batch) ? optional<ForecastSnapshot>(join(runtime,'forecast-'+batch+'.json')) : forecast},
    observations:async()=>{await ready;return observations}}
}
