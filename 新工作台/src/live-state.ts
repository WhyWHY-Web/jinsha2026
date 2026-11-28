import { useEffect,useState } from 'react'
import type { ForecastSnapshot,LiveStatus,SourceStatus } from '../server/live-types'
export type ForecastReply={snapshot:ForecastSnapshot|null;usable:boolean;sourceStatus?:SourceStatus}
export const freshnessNames:Record<SourceStatus['state'],string>={fresh:'最新可用',delayed:'源端延迟 / 已过期',failed:'采集失败',invalid:'质量未通过',missing:'尚无资料',archive:'历史背景',offline:'离线快照'}
export const dateTime=(value:string|null|undefined)=>value ? new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})+' 北京时间' : '未提供'

export function useLiveStatus() {
  const [status,setStatus]=useState<LiveStatus|null>(null),[error,setError]=useState(''),[version,setVersion]=useState(0)
  useEffect(()=>{
    const controller=new AbortController()
    async function load() {
      try {
        const response=await fetch('/api/live/status',{signal:controller.signal})
        if(!response.ok)throw new Error('资料状态暂不可用')
        const payload=await response.json();if(!controller.signal.aborted){setStatus(payload);setError('')}
      }catch(error){if(!controller.signal.aborted)setError(String((error as Error).message))}
    }
    void load();const timer=window.setInterval(()=>void load(),30_000)
    return ()=>{controller.abort();window.clearInterval(timer)}
  },[version])
  return {status,error,refresh:()=>setVersion(v=>v+1)}
}
