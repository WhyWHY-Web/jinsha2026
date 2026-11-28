import type { Station, StationMark } from './data'

export type WarningIndicator = 'precipitation' | 'temperature' | 'forest' | 'eei'
export type WarningLevel = 0 | 1 | 2 | 3 | 4 | 5
const finite = (value:number|null) => value !== null && Number.isFinite(value) ? value : null

export const warningIndicators: Record<WarningIndicator,{ name:string; unit:string; digits:number; direction:'low'|'high'; value:(station:Station)=>number|null }> = {
  precipitation:{ name:'年降水量', unit:'mm', digits:0, direction:'low', value:station=>finite(station.precip) },
  temperature:{ name:'年均气温', unit:'°C', digits:1, direction:'high', value:station=>finite(station.temp) },
  forest:{ name:'林地占比', unit:'%', digits:1, direction:'low', value:station=>{
    const raw = station.cover?.['林地']
    return typeof raw === 'number' && Number.isFinite(raw) ? (raw <= 1 ? raw * 100 : raw) : null
  } },
  eei:{ name:'历史 EEI', unit:'分', digits:1, direction:'low', value:station=>{
    const raw = station.assessment?.eei
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
  } }
}

export const warningLevels = [
  { name:'未列为优先', color:'#70d9cf' },
  { name:'关注一', color:'#68baff' },
  { name:'关注二', color:'#e8ce6e' },
  { name:'关注三', color:'#f4a363' },
  { name:'关注四', color:'#f47579' },
  { name:'数据不足', color:'#8295a6' }
] as const

export interface WarningReading {
  value:number|null
  score:number
  level:WarningLevel
}
export interface WarningStation {
  station:Station
  readings:Record<WarningIndicator,WarningReading>
  level:WarningLevel
  main:WarningIndicator
}

const indicatorIds = Object.keys(warningIndicators) as WarningIndicator[]

export function screenWarnings(stations:Station[]):WarningStation[] {
  const ranked = Object.fromEntries(indicatorIds.map(id=>{
    const { value,direction } = warningIndicators[id]
    const values = stations.map(value).filter((item):item is number=>item !== null && Number.isFinite(item))
      .sort((a,b)=>direction === 'low' ? a-b : b-a)
    return [id,values]
  })) as Record<WarningIndicator,number[]>
  return stations.map(station=>{
    const readings = Object.fromEntries(indicatorIds.map(id=>{
      const value = warningIndicators[id].value(station)
      const order = ranked[id]
      const score = value === null || order.length < 2 || order[0] === order.at(-1) ? 0 : 1 - order.indexOf(value) / order.length
      // shortcut: Relative ranks are exploratory; replace with calibrated regional thresholds when available.
      const level:WarningLevel = value === null || order.length < 2 ? 5 : score > .95 ? 4 : score > .90 ? 3 : score > .85 ? 2 : score > .80 ? 1 : 0
      return [id,{value,score,level}]
    })) as Record<WarningIndicator,WarningReading>
    const main = indicatorIds.reduce((best,id)=>readings[id].score > readings[best].score ? id : best)
    const valid = indicatorIds.filter(id=>readings[id].level !== 5)
    return { station,readings,main,level:valid.length === indicatorIds.length ? readings[main].level : 5 }
  })
}

export function indicatorMarks(rows:WarningStation[], indicator:WarningIndicator):Record<string,StationMark> {
  const meta = warningIndicators[indicator]
  return Object.fromEntries(rows.map(row=>{
    const reading = row.readings[indicator]
    return [row.station.id,{
      reading:reading.value === null ? '暂无数值' : reading.value.toLocaleString('zh-CN',{maximumFractionDigits:meta.digits,minimumFractionDigits:meta.digits})+' '+meta.unit,
      color:reading.value === null ? '#8295a6' : warningLevels[reading.level].color,
      priority:reading.score
    }]
  }))
}
