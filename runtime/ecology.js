import { readFile, stat } from './snapshot-io.js'
import { join } from './snapshot-io.js'

const coverFields = ['林地', '草地灌丛', '农田', '建成区', '裸地', '水体', '湿地']



















export class EcologyInputError extends Error {
           status
  constructor(message       ,status=400) {
    super(message)
    this.status = status
  }
}

const climateDataset = 'NASA POWER / MERRA-2 站点再分析'
const formulaVersion = 'jinsha-legacy-ecology-v1'
const metricDefinitions = [
  {id:'eei',name:'生态环境综合指数 EEI',unit:'分',description:'八项指标按项目既有权重合成'},
  {id:'ei',name:'生态状况指数 EI',unit:'分',description:'生物丰度、植被覆盖、水网密度与土地胁迫合成'},
  {id:'risk',name:'综合生态风险敏感性',unit:'分',description:'既有滑坡敏感性、退化代理和土地胁迫的加权分'},
  {id:'slide',name:'滑坡敏感性',unit:'分',description:'基于坡度、起伏、年降水和植被的经验静态筛查'},
  {id:'deg',name:'森林与植被退化压力',unit:'分',description:'覆盖、经验干旱度、建设用地与林地的代理分'},
  {id:'lsi',name:'土地胁迫',unit:'分',description:'坡度、起伏、建设用地及裸地的压力代理分'},
  {id:'carbon',name:'植被碳密度估算',unit:'tC/ha',description:'土地覆盖系数按年降水调节，无样地碳储量验证'},
  {id:'fvc',name:'植被覆盖代理',unit:'比例',description:'由土地覆盖类别系数估算'},
  {id:'abi',name:'生物丰度代理',unit:'分',description:'土地覆盖类别加权'},
  {id:'wri',name:'水网密度代理',unit:'分',description:'综合降水与水域、湿地占比'},
  {id:'habitat',name:'生境质量',unit:'指数',description:'按土地覆盖类别加权，范围 0–1'},
  {id:'biodiversity',name:'生物多样性代理',unit:'指数',description:'由生境质量与林地比例估算'},
  {id:'water',name:'水源涵养代理',unit:'mm',description:'年降水与林地比例的经验关系'},
  {id:'soil',name:'土壤保持代理',unit:'模型量',description:'林草覆盖与坡度的经验关系，范围 0–40'},
  {id:'climate',name:'气候调节代理',unit:'指数',description:'林草覆盖加权，范围 0–1'},
  {id:'resilience',name:'生态韧性代理',unit:'指数',description:'林草覆盖与建设用地的经验关系'},
  {id:'esv',name:'生态服务价值代理',unit:'指数',description:'林草、湿地、水体与裸地的经验合成，范围 0–4'},
  {id:'disturbance',name:'人类干扰代理',unit:'指数',description:'建设用地、农田及裸地加权，范围 0–1'}
]


const scenarios = [
  {id:'baseline',name:'基准评估',description:'使用对应站点档案及当前的数据修订'},
  {id:'restoration',name:'植被恢复',description:'将最多 5 个百分点可转换土地转移至林地，依次从裸地、草地灌丛、农田转移'},
  {id:'degradation',name:'森林退化',description:'将最多 5 个百分点林地转移至裸地'},
  {id:'drought',name:'降水减少',description:'年降水减少 20%'},
  {id:'wet',name:'降水增加',description:'年降水增加 20%'},
  {id:'warming',name:'气温上升',description:'年平均气温增加 2 °C'}
]


const cache = new Map                                                    ()
async function readJson   (path       )             {
  const info = await stat(path)
  const found = cache.get(path)
  if (found && found.mtime === info.mtimeMs && found.size === info.size) return found.contents
  const contents         = JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''))
  cache.set(path,{mtime:info.mtimeMs,size:info.size,contents})
  return contents
}
const numeric = (value        )                  => typeof value === 'number' && Number.isFinite(value)
const round = (value       , places=4) => Number(value.toFixed(places))
const mean = (values         ) => values.reduce((sum,value)=>sum+value,0)/values.length
const within = (value       , lower       , upper       ) => Math.max(lower,Math.min(upper,value))
const grade = (value       )       => value >= 75 ? 'A' : value >= 65 ? 'B' : value >= 55 ? 'C' : 'D'
const riskLevel = (value       )           => value >= 58 ? '高' : value >= 45 ? '中' : '低'

export function stationEcology({temp,precip,slope,relief,cover}                )          {
  const [f,g,c,b,ba,w,we] = coverFields.map(key=>cover[key])
  const fvc = Math.min(1, .92*f + .62*g + .55*c + .75*we + .05*ba + .08*b)
  const carbon = (52*f + 7.5*g + 5.2*c + 18*we + .4*ba + 1.2*b) * (.72 + .28*within(precip/1200,.45,1.35))
  const slide = 100*(.42*within((slope-4)/28,0,1) + .18*Math.min(1,relief/800)
    + .22*Math.min(1,precip/1600) + .18*(1-Math.min(1,.8*f+.35*g)))
  const dry = within((temp-6)/18,0,1)*within(1-precip/1800,.15,1)
  const deg = 100*(.4*(1-fvc) + .3*dry + .18*Math.min(1,b/.10) + .12*(1-f))
  const lsi = 100*(.45*within((slope-5)/30,0,1) + .30*Math.min(1,relief/900)
    + .15*Math.min(1,b/.12) + .10*Math.min(1,ba/.15))
  const abi = 100*(.35*f + .21*g + .28*(w+we) + .11*c + .04*b + .01*ba)
  const wri = 100*(.70*Math.min(1,precip/1600) + .30*Math.min(1,(w+we)/.05))
  const ei = (.35*abi + .25*fvc*100 + .15*wri + .15*(100-lsi))/.90
  const risk = .42*slide + .33*deg + .25*lsi
  const habitat = Math.min(1,.95*f + .72*g + .90*we + .78*w + .42*c + .08*b + .20*ba)
  const biodiversity = Math.min(1, habitat*(.78+.22*f))
  const water = precip*(.50+.42*f)
  const soil = within(10+40*f-.20*slope+5*g,0,40)
  const climate = Math.min(1,.35+.50*f+.20*g)
  const resilience = within(.30+.55*f+.20*g-.15*b,.08,1)
  const esv = within(1+3*f+1.3*g+.9*we+.5*w-.3*ba,0,4)
  const disturbance = Math.min(1,2.8*b+.45*c+.5*ba)
  const eei = 18*habitat+15*biodiversity+14*(water/1000)+12*(soil/40)
    +12*climate+11*resilience+10*(esv/4)+8*(1-disturbance)
  return {eei,ei,risk,slide,deg,lsi,carbon,fvc,abi,wri,habitat,biodiversity,water,soil,climate,resilience,esv,disturbance}
}

function scenarioInputs(input                ,scenario         )                 {
  const result = {...input,cover:{...input.cover}}
  if (scenario === 'drought') result.precip *= .8
  if (scenario === 'wet') result.precip *= 1.2
  if (scenario === 'warming') result.temp += 2
  if (scenario === 'degradation') {
    const converted = Math.min(.05,result.cover.林地)
    result.cover.林地 -= converted
    result.cover.裸地 += converted
  }
  if (scenario === 'restoration') {
    let remaining = .05
    for (const key of ['裸地','草地灌丛','农田']         ) {
      const converted = Math.min(remaining,result.cover[key])
      result.cover[key] -= converted
      result.cover.林地 += converted
      remaining -= converted
    }
  }
  return result
}

function ringStatus(ring           ,point         ) {
  let contained = false
  const [x,y] = point
  for (let i=0,j=ring.length-1;i<ring.length;j=i++) {
    const [ax,ay] = ring[i], [bx,by] = ring[j]
    if (x >= Math.min(ax,bx) && x <= Math.max(ax,bx) && y >= Math.min(ay,by) && y <= Math.max(ay,by)
      && Math.abs((x-ax)*(by-ay)-(y-ay)*(bx-ax)) < 1e-12) return 'boundary'
    if ((ay > y) !== (by > y) && x < (bx-ax)*(y-ay)/(by-ay)+ax) contained = !contained
  }
  return contained ? 'inside' : 'outside'
}

function covers(geometry         , point         ) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates
  return polygons.some(([exterior,...holes]) => ringStatus(exterior,point) !== 'outside'
    && holes.every(hole=>ringStatus(hole,point)!=='inside'))
}

function definitions(stations          , basins        ) {
  const partition = (id       ,name       ,kind       ,includes                         ) => ({
    id,name,kind,count:stations.filter(includes).length,includes
  })
  return [
    partition('basin','全流域站点','basin',()=>true),
    partition('seg_up','上游河段','section',row=>row.lon<100),
    partition('seg_mid','中游河段','section',row=>row.lon>=100 && row.lon<102.8),
    partition('seg_low','下游河段','section',row=>row.lon>=102.8),
    ...Array.from(new Set(stations.map(row=>row.zone))).sort().map(zone=>partition('zone:'+zone,zone,'zone',row=>row.zone===zone)),
    ...basins.map(feature=> {
      const id = String(feature.properties.HYBAS_ID)
      return partition('subbasin:'+id,'子流域 '+id,'subbasin',row=>covers(feature.geometry,[row.lon,row.lat]))
    })
  ]
}

async function loadEcology(dataDir       ) {
  const [registry,annual,geometries] = await Promise.all([
    readJson                      (join(dataDir,'stations.json')),
    readJson               (join(dataDir,'climate_annual.json')),
    readJson                    (join(dataDir,'basin','jinsha_basin.geojson'))
  ])
  return {stations:registry.stations,annual,basins:geometries.features}
}
const listYears = (rows              ) => Array.from(new Set(rows.map(row=>row.year))).sort((a,b)=>a-b)

export async function ecologyOptions(dataDir       ) {
  const {stations,annual,basins} = await loadEcology(dataDir)
  const publicRegions = definitions(stations,basins).map(({id,name,kind,count})=>({id,name,kind,count}))
  return {regions:publicRegions,years:listYears(annual),scenarios,metricDefinitions,method:formulaVersion}
}

function yearParameter(value            ,years         ) {
  if (!value) return null
  const year = Number(value)
  if (!/^\d{4}$/.test(value) || !years.includes(year)) throw new EcologyInputError('请选择气候档案中的四位年份')
  return year
}

function scopeParameter(params                , stations          , basins        ) {
  const id = params.get('scope') ?? (params.has('station') ? 'station:'+params.get('station') : params.has('bbox') ? 'bbox' : 'basin')
  if (id.startsWith('station:')) {
    const stationId = id.slice('station:'.length)
    const station = stations.find(row=>row.id===stationId)
    if (!station) throw new EcologyInputError('未找到指定站点',404)
    return {id,name:station.name,kind:'station',includes:(row        )=>row.id===stationId}
  }
  if (id === 'bbox') {
    const raw = params.get('bbox')?.split(',').map(part=>part.trim())
    if (raw?.length!==4 || raw.some(part=>!part || !numeric(Number(part)))) throw new EcologyInputError('框选范围须包含西、南、东、北四个坐标')
    const bounds = raw.map(Number)
    const [west,south,east,north] = bounds
    if (west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) throw new EcologyInputError('框选范围的坐标无效')
    return {id,name:'自定义范围',kind:'bbox',bbox:bounds,includes:(row        )=>row.lon>=west && row.lon<=east && row.lat>=south && row.lat<=north}
  }
  const region = definitions(stations,basins).find(row=>row.id===id)
  if (!region) throw new EcologyInputError('未找到指定范围',404)
  return region
}

function meanClimate(timeseries                                               , station        )         {
  const valid = timeseries?.filter(row=>numeric(row[1]) && numeric(row[2]) && row[2]>=0) ?? []
  return valid.length ? {temp:mean(valid.map(row=>row[1])),precip:mean(valid.map(row=>row[2])),source:climateDataset+'多年均值'}
    : {temp:station.temp,precip:station.precip,source:station.climSrc ?? '站点台账气候参考值'}
}
function roundMetrics(values        ) {
  return Object.fromEntries(metricDefinitions.map(({id})=>[id,round(values[id])]))
}
function metricDifferences(left        ,right        ) {
  return Object.fromEntries(metricDefinitions.map(({id})=>[id,left[id]-right[id]]))
}
function metricMeans(series          ) {
  if (!series.length) return null
  return Object.fromEntries(metricDefinitions.map(({id})=>[id,round(mean(series.map(row=>row[id])))]))
}
function distanceKm(a        ,b        ) {
  return 111*Math.hypot((a.lon-b.lon)*Math.cos((a.lat+b.lat)*Math.PI/360),a.lat-b.lat)
}
function median(values         ) {
  const sorted = [...values].sort((a,b)=>a-b)
  const mid = Math.floor(sorted.length/2)
  return sorted.length%2 ? sorted[mid] : (sorted[mid-1]+sorted[mid])/2
}
const anomalyRules = [
  {field:'temp',name:'年均气温',unit:'°C',zmin:0,relmin:0,absmin:2.5},
  {field:'precip',name:'年降水',unit:'mm',zmin:3,relmin:.15,absmin:0},
  {field:'slope',name:'坡度',unit:'°',zmin:3,relmin:.40,absmin:0},
  {field:'lc.林地',name:'林地占比',unit:'比例',zmin:5,relmin:.5,absmin:0},
  {field:'lc.草地灌丛',name:'草地灌丛占比',unit:'比例',zmin:5,relmin:.5,absmin:0},
  {field:'lc.农田',name:'农田占比',unit:'比例',zmin:5,relmin:.5,absmin:0}
]
function qualityScreen(entries                                               , ids            ) {
  if (entries.length < 5) return []
  return anomalyRules.flatMap(rule=> {
    const value = (input                ) => rule.field === 'temp' ? input.temp
      : rule.field === 'precip' ? input.precip : rule.field === 'slope' ? input.slope
      : input.cover[rule.field.slice(3)              ]
    const vals = entries.map(row=>value(row.input))
    const center = median(vals)
    const deviations = vals.map(item=>Math.abs(item-center)).sort((a,b)=>a-b)
    const scale = (deviations[Math.floor(vals.length/2)]*1.4826) || mean(deviations) || 1e-9
    return entries.filter(({station})=>ids.has(station.id)).flatMap(({station,input})=>{
      const near = entries.filter(row=>row.station.id!==station.id).map(row=>({...row,distance:distanceKm(station,row.station)}))
        .sort((a,b)=>a.distance-b.distance).slice(0,3)
      const weights = near.map(row=>1/Math.max(row.distance,1))
      const adjusted = near.map(row=>value(row.input)+(rule.field==='temp' ? .0065*(row.station.elev-station.elev) : 0))
      const reference = adjusted.reduce((total,item,index)=>total+item*weights[index],0)/weights.reduce((a,b)=>a+b,0)
      const observed = value(input)
      const z = (observed-center)/scale
      const relative = (observed-reference)/Math.max(Math.abs(reference),1e-9)
      const hit = rule.absmin ? Math.abs(observed-reference)>=rule.absmin : Math.abs(z)>=rule.zmin && Math.abs(relative)>=rule.relmin
      if (!hit) return []
      return [{
        stationId:station.id,station:station.name,field:rule.field,name:rule.name,unit:rule.unit,
        value:round(observed),reference:round(reference),z:round(z,2),relativePct:round(relative*100,1),
        nearestKm:round(near[0].distance,1),level:Math.abs(z)>=4.5 || Math.abs(relative)>=1 ? '高' : '中',
        note:'疑似异常，待核对原始来源及站点环境'
      }]
    })
  }).sort((a,b)=>Number(b.level==='高')-Number(a.level==='高') || Math.abs(b.z)-Math.abs(a.z))
}

export async function evaluateEcology(
  dataDir       ,params                ,overrides                 ={},comparisonOverrides                 ={}
) {
  const [{stations,annual,basins}, climateArchive, greenness] = await Promise.all([
    loadEcology(dataDir),
    readJson                                                                         (join(dataDir,'climate.json')).catch(()=>null),
    readJson                   (join(dataDir,'gee','annual.json')).catch(()=>null)
  ])
  const years = listYears(annual)
  const year = yearParameter(params.get('year'),years)
  const compareYear = yearParameter(params.get('compareYear'),years)
  const selectedScenario = scenarios.find(item=>item.id===(params.get('scenario') ?? 'baseline'))
  if (!selectedScenario) throw new EcologyInputError('评估情景无效')
  const {includes,...scope} = scopeParameter(params,stations,basins)
  const selected = stations.filter(includes)
  const climateByYear = new Map(annual.map(row=>[row.station+'|'+row.year,row]))

  function inputs(station        ,targetYear            ,adjustment                                   ) {
    const row = targetYear === null ? undefined : climateByYear.get(station.name+'|'+targetYear)
    if (!numeric(station.slope) || !station.lc) return null
    const amendedFields = (['temp','precip']         ).filter(field=>numeric(adjustment?.[field]))
    const archived = targetYear === null ? meanClimate(climateArchive?.stations?.[station.name]?.years,station) : {
      temp:row?.temp_c,precip:row?.precip_mm,source:row?.source ?? climateDataset
    }
    const temp = adjustment?.temp ?? archived.temp
    const precip = adjustment?.precip ?? archived.precip
    if (!numeric(temp) || !numeric(precip) || precip<0) return null
    const cover = Object.fromEntries(coverFields.map(field=>[field,station.lc?.[field] ?? 0]))
    if (Object.values(cover).some(value=>!numeric(value) || value<0 || value>1)) return null
    const input                 = {
      temp,precip,
      relief:station.relief ?? 0,
      slope:station.slope,cover
    }
    const climateSource = amendedFields.length===2 ? '本地气候资料修订' : archived.source
    return {station,input,climateSource,amendedFields}
  }

  const allInputs = stations.flatMap(station=> {
    const entry = inputs(station,year,year===null ? undefined : overrides[station.id])
    return entry ? [entry] : []
  })
  const ids = new Set(selected.map(station=>station.id))
  const rows = allInputs.filter(row=>ids.has(row.station.id)).map(({station,input,climateSource,amendedFields})=>{
    const modeled = scenarioInputs(input,selectedScenario.id)
    const base = stationEcology(input)
    const metrics = stationEcology(modeled)
    const ndvi = year===null ? null : greenness?.ndvi?.[station.name]?.find(([label])=>Number(label)===year)?.[1] ?? null
    return {
      id:station.id,name:station.name,lon:station.lon,lat:station.lat,zone:station.zone,type:station.type,
      elev:station.elev,grade:grade(metrics.eei),riskLevel:riskLevel(metrics.risk),ndvi,
      inputs:{...modeled,year,climateSource,coverSource:station.lcSrc ?? '站点土地覆盖档案',amendedFields},
      metrics:roundMetrics(metrics),baselineMetrics:roundMetrics(base),delta:roundMetrics(metricDifferences(metrics,base))
    }
  })
  const aggregates = metricMeans(rows.map(row=>row.metrics))
  const grades                      = {A:0,B:0,C:0,D:0}
  const riskLevels                          = {'高':0,'中':0,'低':0}
  rows.forEach(row=>{grades[row.grade]++;riskLevels[row.riskLevel]++})
  const present = new Set(rows.map(row=>row.id))
  const missingStations = selected.filter(row=>!present.has(row.id)).map(row=>row.name)
  const pairs = compareYear === null ? [] : rows.flatMap(row=> {
    const station = selected.find(value=>value.id===row.id)
    const earlier = inputs(station,compareYear,(compareYear===year ? overrides : comparisonOverrides)[station.id])
    return earlier ? [{current:row.metrics,earlier:stationEcology(scenarioInputs(earlier.input,selectedScenario.id))}] : []
  })
  const comparisonMeans = metricMeans(pairs.map(row=>row.earlier))
  const currentMeans = metricMeans(pairs.map(row=>row.current))
  const comparison = compareYear===null ? null : {
    year:compareYear,count:pairs.length,means:comparisonMeans,
    delta:comparisonMeans && currentMeans ? roundMetrics(metricDifferences(currentMeans,comparisonMeans)) : null
  }
  return {
    ok:true,method:formulaVersion,scope,year,scenario:selectedScenario,metricDefinitions,stations:rows,
    summary:{count:rows.length,eligible:selected.length,means:aggregates,grades,riskLevels},comparison,
    quality:{
      missingStations,anomalies:qualityScreen(allInputs,ids),
      notes:[
        'EEI、EI、碳密度与风险为经验模型结果。滑坡敏感性用于筛查，风险分值无实时预警能力。',
        '区域值为纳入站点等权平均。地形和土地覆盖采用档案的固定站点属性。',
        '情景变化为基于同一输入的单项敏感性分析。跨年比较仅使用两期均有数据的相同站点。'
      ]
    }
  }
}

















const loadRseiSupport = (newDataDir       ) => readJson             (join(newDataDir,'ecology','rsei-support.json'))

export async function ecologyRseiLayer(newDataDir       ,year       ) {
  const support = await loadRseiSupport(newDataDir)
  if (!support.rasterSources.some(row=>row.year===year)) throw new EcologyInputError('请选择 RSEI 档案年份')
  const entries = Object.values(support.regions).flatMap(region=>{
    if (!region.id.startsWith('subbasin:')) return []
    const record = region.records.find(row=>row.year===year)
    const coverage = record && region.areaKm2 > 0 ? within(record.coverageKm2/region.areaKm2,0,1) : 0
    return [{id:region.id.slice('subbasin:'.length),value:record?.value ?? null,coverage:round(coverage,6)}]
  })
  return {
    year, source:support.source, method:support.version, note:support.note,
    values:Object.fromEntries(entries.map(row=>[row.id,row.value])),
    coverage:Object.fromEntries(entries.map(row=>[row.id,row.coverage]))
  }
}

export async function ecologyRsei(dataDir       ,newDataDir        ,scope='basin') {
  const [rows,support] = await Promise.all([
    readJson           (join(dataDir,'rsei','rsei_all.json')),
    newDataDir ? loadRseiSupport(newDataDir).catch(error=>{
      if (error?.code==='ENOENT') return null
      throw error
    }) : null
  ])
  if (support && !Object.hasOwn(support.regions,scope)) throw new EcologyInputError('RSEI 对照支持全流域及水文子流域范围',404)
  const research = support ? {
    version:support.version,source:support.source,boundarySha256:support.boundarySha256,
    rasterSources:support.rasterSources,pixelSizeDegrees:support.pixelSizeDegrees,crs:support.crs,note:support.note,
    region:support.regions[scope],
    regions:Object.values(support.regions).map(({id,areaKm2})=>({id,areaKm2}))
  } : null
  return {
    source:'Landsat 生态指数归档',mode:'各期有效覆盖',spatialResultsVerified:false,
    records:[...rows].sort((a,b)=>a.year-b.year).map(row=>({
      year:row.year,sensor:row.sensor,scenes:row.n_scenes,value:row.rsei_mean,
      coverageKm2:row.total_area_km2,loadings:row.pc1_loadings,
      components:{ndvi:row.ndvi_mean,wet:row.wet_mean,ndbsi:row.ndsi_mean,lst:row.lst_mean},
      classes:Array.from({length:5},(_,index)=>row[`class_${index}_pct`] ?? null)
    })),
    research,notes:[
      '各期有效覆盖和部分 Landsat 传感器不同，结果只作各期档案描述。',
      '旧 LISA 样点存在流域外样本，空间集聚结论需在统一边界和掩膜下重新计算。'
    ]
  }
}
