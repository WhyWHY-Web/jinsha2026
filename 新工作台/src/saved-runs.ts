import type { AssessmentReport } from './ecology-types'
import type { ForecastSnapshot } from '../server/live-types'
import { verifyAssessment } from './assessment-export.ts'

type SavedBase={schema:'jinsha-evidence-v1';id:string;title:string;savedAt:string;viewUrl:string}
export type SavedRun=(SavedBase & {kind:'assessment';report:AssessmentReport}) |
  (SavedBase & {kind:'forecast';snapshot:ForecastSnapshot;selection:{scope:string;bbox:string;day:string}})
const key='jinsha-evidence-v1'
export function assessmentEvidence(report:AssessmentReport,viewUrl:string):SavedRun {
  const url=new URL(viewUrl),p=report.run.parameters
  for(const [key,value] of Object.entries({scene:'ecology',scope:p.scope,year:p.year===null?'baseline':String(p.year),
    scenario:p.scenario,run:report.run.sha256}))url.searchParams.set(key,value)
  if(p.scope.startsWith('station:'))url.searchParams.set('station',p.scope.slice(8));else url.searchParams.delete('station')
  if(p.bbox)url.searchParams.set('bbox',p.bbox.join(','));else url.searchParams.delete('bbox')
  if(p.compareYear!==null)url.searchParams.set('compareYear',String(p.compareYear));else url.searchParams.delete('compareYear')
  return {schema:'jinsha-evidence-v1',kind:'assessment',id:report.run.sha256,title:report.scope.name+' · '+(report.year ?? '台账基准')+' · '+report.scenario.name,
    savedAt:new Date().toISOString(),viewUrl:url.href,report}
}
async function hash(value:unknown) {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)))
  return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('')
}
export async function forecastEvidence(snapshot:ForecastSnapshot,selection:{scope:string;bbox:string;day:string},viewUrl:string):Promise<SavedRun> {
  const url=new URL(viewUrl);url.searchParams.set('scene','forecast');url.searchParams.set('batch',snapshot.id);url.searchParams.delete('run')
  return {schema:'jinsha-evidence-v1',kind:'forecast',id:await hash({snapshot,selection}),title:selection.scope+' · 七天气象驱动'+(selection.day?' · '+selection.day:''),
    savedAt:new Date().toISOString(),viewUrl:url.href,snapshot,selection}
}
export function savedRuns():SavedRun[] {
  const text=localStorage.getItem(key)
  if(!text)return []
  const value=JSON.parse(text)
  if(!Array.isArray(value) || value.some(run=>run.schema!=='jinsha-evidence-v1'))throw new Error('本地成果格式异常，请先备份浏览器存储再修复。')
  return value
}
export function saveRun(run:SavedRun) {
  const rows=savedRuns()
  if(rows.some(row=>row.id===run.id))return
  if(rows.length>=30)throw new Error('已保存 30 份成果，请先导出并移除不再需要的成果。')
  try {localStorage.setItem(key,JSON.stringify([run,...rows]))}
  catch {throw new Error('浏览器存储空间不足，请先下载证据 JSON 备份。')}
}
export function removeRun(id:string) {localStorage.setItem(key,JSON.stringify(savedRuns().filter(row=>row.id!==id)))}
export async function verifySaved(run:SavedRun) {
  if(run.schema!=='jinsha-evidence-v1' || !run.id || !run.title || !run.viewUrl)return false
  if(run.kind==='assessment')return run.id===run.report?.run?.sha256 && await verifyAssessment(run.report)
  if(run.kind!=='forecast' || !run.snapshot?.stations?.length || !run.selection)return false
  const dataHash=await hash({retrievedAt:run.snapshot.retrievedAt,stations:run.snapshot.stations})
  return dataHash===run.snapshot.sha256 && run.id===await hash({snapshot:run.snapshot,selection:run.selection})
}
