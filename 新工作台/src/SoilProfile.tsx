import { useEffect, useState } from 'react'
import './soil-profile.css'

export const SOIL_ARCHIVE_ID = 'isric-soilgrids-2-topsoil'
const depths = ['0-5cm', '5-15cm', '15-30cm'] as const
export type SoilDepth = typeof depths[number]

type ScientificSummary = {
  archive: { fields: Array<{field:string; label:string; unit:string; decimals?:number}> }
  scope: { kind:string; id:string | null }
  profiles: Array<{
    depth:string; inside:number; samples:number; coverage:number
    properties: Record<string,{mean:number; median:number; p10:number; p90:number} | null>
  }>
  basins: Array<{ id:string }>
}

type SoilSelection = { basin:string; depth:SoilDepth }
export const defaultSoilSelection: SoilSelection = { basin:'', depth:depths[0] }

export function soilArchiveQuery({basin, depth}: SoilSelection) {
  return ',' + (basin ? basin+',' : '') + depth + ','
}

const units = new Intl.NumberFormat('zh-CN')
const coverageFormat = new Intl.NumberFormat('zh-CN', {style:'percent',maximumFractionDigits:2})

export function SoilProfile({ selection, onChange }: {
  selection: SoilSelection; onChange: (selection:SoilSelection)=>void
}) {
  const {basin,depth} = selection
  const [response,setResponse] = useState<ScientificSummary | null>(null)
  const [failedBasin,setFailedBasin] = useState<string | null>(null)

  useEffect(() => {
    const ctrl = new AbortController()
    setFailedBasin(null)
    const endpoint = basin ? '/api/scientific?'+new URLSearchParams({basin}) : '/api/scientific'
    fetch(endpoint,{signal:ctrl.signal}).then(reply=>{
      if (!reply.ok) throw new Error('Soil profile unavailable')
      return reply.json() as Promise<ScientificSummary>
    }).then(result=>{ if (!ctrl.signal.aborted) setResponse(result) })
      .catch(()=>{ if (!ctrl.signal.aborted) setFailedBasin(basin) })
    return ()=>ctrl.abort()
  },[basin])

  const profile = (response?.scope.id ?? '') === basin && response?.profiles.find(item=>item.depth===depth)
  return <div className="soil-profile" aria-label="土壤剖面统计">
    <div className="soil-selectors">
      <label>范围 <select value={basin} aria-label="土壤统计范围" onChange={event=>onChange({...selection,basin:event.target.value})}>
        <option value="">金沙江全流域</option>
        {response?.basins.map(({id})=><option value={id} key={id}>子流域 {id}</option>)}
      </select></label>
      <label>深度 <select value={depth} aria-label="土壤深度" onChange={event=>onChange({...selection,depth:event.target.value as SoilDepth})}>
        {depths.map(value=><option value={value} key={value}>{value.replace('-', '–').replace('cm', ' cm')}</option>)}
      </select></label>
      <span role="status">{failedBasin===basin ? '剖面统计暂不可用' : profile
        ? units.format(profile.samples)+' 个有效网格 · '+coverageFormat.format(profile.coverage)+' 覆盖'
        : '正在读取土壤剖面'}</span>
    </div>
    {profile && <dl className="soil-values">{response?.archive.fields.map(({field,label,unit,decimals})=>{
      const stat = profile.properties[field]
      const value = (number:number)=>number.toFixed(decimals ?? 2)
      return <div key={field} title={stat ? '样点均值。样点分布 P10–P90 '+value(stat.p10)+'–'+value(stat.p90)+' '+unit : undefined}>
        <dt>{label}</dt><dd>{stat ? value(stat.mean) : '—'} <small>{unit}</small></dd>
      </div>
    })}</dl>}
  </div>
}
