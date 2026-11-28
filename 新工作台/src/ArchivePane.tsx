import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import type { Dataset } from './data'
import { PanelHeader } from './PanelHeader'
import { DataTable, type TableColumn } from './DataTable'
import { defaultSoilSelection, SOIL_ARCHIVE_ID, soilArchiveQuery, SoilProfile } from './SoilProfile'

type Records = { columns:string[]; rows:string[][]; nextOffset:number|null }

const headings: Record<string,string> = {
  station_id:'站号', date:'日期', year:'年份', month:'月份', element:'指标', value:'值', unit:'单位',
  longitude:'经度', latitude:'纬度', lon:'经度', lat:'纬度', grid_id:'网格', class_code:'类别代码',
  class_name:'地表类型', precipitation_mm:'降水 mm', precip_mm:'降水 mm',
  basin_id:'子流域编号', depth:'深度', ph_h2o:'pH（水）', organic_carbon_g_kg:'有机碳 g/kg',
  clay_pct:'黏粒 %', bulk_density_g_cm3:'容重 g/cm³',
}

export function ArchivePane({ dataset, onClose }: { dataset:Dataset, onClose:()=>void }) {
  const soil = dataset.id===SOIL_ARCHIVE_ID
  const [soilSelection, setSoilSelection] = useState(defaultSoilSelection)
  const [query,setQuery] = useState('')
  const [year,setYear] = useState('')
  const [filter,setFilter] = useState({ query:soil?soilArchiveQuery(defaultSoilSelection):'',year:'',offset:0 })
  const [records,setRecords] = useState<Records | null>(null)
  const [error,setError] = useState('')
  useEffect(() => {
    const ctrl = new AbortController()
    const params = new URLSearchParams({ q:filter.query,year:filter.year,offset:String(filter.offset),limit:'24' })
    setRecords(null)
    setError('')
    fetch('/api/archives/'+dataset.id+'?'+params,{signal:ctrl.signal}).then(response => {
      if (!response.ok) throw new Error('无法读取该数据集')
      return response.json() as Promise<Records>
    }).then(setRecords).catch(e => { if (e.name!=='AbortError') setError(e.message) })
    return ()=>ctrl.abort()
  },[dataset.id,filter])
  return <section className="archive-view hud" aria-label="数据表浏览">
    <PanelHeader title={dataset.label ?? dataset.name} state={error ? 'error' : !records ? 'loading' : !records.rows.length ? 'empty' : undefined}
      actions={<button type="button" className="icon-btn" onClick={onClose} aria-label="关闭数据表"><X size={18}/></button>}/>
    <div className="archive-info"><strong>{dataset.rows?.toLocaleString('zh-CN') ?? '—'} 条</strong>
      <span>{dataset.startYear!==undefined && (dataset.endYear!==undefined && dataset.endYear!==dataset.startYear
        ? dataset.startYear+'–'+dataset.endYear+' · ' : dataset.startYear+' · ')}{dataset.kind}</span>
      <p>{dataset.description ?? dataset.source}</p>
      {dataset.sourceUrl && <a target="_blank" rel="noreferrer" href={dataset.sourceUrl}>来源</a>}
      {dataset.licenseUrl && <a target="_blank" rel="noreferrer" href={dataset.licenseUrl}>许可</a>}
    </div>
    {soil ? <SoilProfile selection={soilSelection} onChange={selection=>{
      setSoilSelection(selection)
      setFilter({query:soilArchiveQuery(selection),year:'',offset:0})
    }}/> : <form onSubmit={event=>{event.preventDefault();setFilter({query:query.trim(),year,offset:0})}} className="archive-filter">
      <input value={query} onChange={event=>setQuery(event.target.value)} aria-label="数据筛选" placeholder="筛选站号、指标或类别"/>
      <input value={year} onChange={event=>setYear(event.target.value)} aria-label="筛选年份" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} placeholder="年份"/>
      <button type="submit">查询</button>
    </form>}
    {records && records.rows.length ? <DataTable className="archive-table" name={dataset.label ?? dataset.name ?? '数据集'} exportLabel="导出本页 CSV"
      rows={records.rows} columns={records.columns.map((field,i):TableColumn<string[]> => ({
        key:field, label:headings[field] ?? field, value:row=>row[i],
        numeric:records.rows.every(row=>row[i]==='' || Number.isFinite(Number(row[i]))),
        sum:['value','precipitation_mm','precip_mm','organic_carbon_g_kg','clay_pct'].includes(field)
      }))}/> : <p className="archive-status" role="status">{error || (records ? '没有符合条件的记录' : '正在读取数据')}</p>}
    <div className="archive-pages">
      <button type="button" disabled={!records || filter.offset===0} onClick={()=>setFilter({...filter,offset:Math.max(0,filter.offset-24)})}>上一页</button>
      <span>{records?.rows.length ? '第 '+(filter.offset+1)+'–'+(filter.offset+records.rows.length)+' 条' : ''}</span>
      <button type="button" disabled={records?.nextOffset==null} onClick={()=>{if(records?.nextOffset!=null)setFilter({...filter,offset:records.nextOffset})}}>下一页</button>
    </div>
  </section>
}
