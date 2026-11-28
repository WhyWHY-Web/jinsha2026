import type { AssessmentReport } from './ecology-types'
export type ExportRow = [string,string,string]
export type ExportView = {
  element:HTMLElement; topic:string; station:string; year:number | string; metric:string;
  rows:ExportRow[]; method:string; source:string; url:string
  run?:AssessmentReport
}

const safeName = (value:string) => value.replace(/[\\/:*?"<>|\s]+/g,'_').slice(0,48)

function download(blob:Blob, filename:string) {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = filename
  link.click()
  window.setTimeout(()=>URL.revokeObjectURL(link.href),60_000)
}

async function screenshot(element:HTMLElement) {
  const {default:html2canvas} = await import('html2canvas')
  return html2canvas(element,{backgroundColor:'#071426',useCORS:true,scale:Math.min(2,window.devicePixelRatio || 1),logging:false,
    onclone:document=>{
      const style = document.createElement('style')
      // html2canvas cannot parse CSS relative colors used by the map pin glow.
      style.textContent = '.pin-shape { box-shadow: 0 0 0 4px rgba(110,205,240,.23), 0 0 15px rgba(110,205,240,.5) !important; }'
      document.head.append(style)
      for (const input of document.querySelectorAll<HTMLInputElement>('input[type="range"]')) {
        const track = document.createElement('div')
        const percent = Math.max(0,Math.min(100,(Number(input.value)-Number(input.min || 0))/Math.max(1,Number(input.max || 100)-Number(input.min || 0))*100))
        track.style.cssText = `width:${input.getBoundingClientRect().width}px;height:8px;margin:7px 0;border-radius:5px;background:linear-gradient(to right,#61ceef ${percent}%,#315370 ${percent}%);`
        input.replaceWith(track)
      }
      document.querySelector('.export-message')?.remove()
    }})
}

const filename = (view:ExportView, extension:string) =>
  `${safeName(view.topic)}_${new Date().toLocaleDateString('en-CA')}_${safeName(view.station)}.${extension}`

export async function exportPng(view:ExportView) {
  const canvas = await screenshot(view.element)
  const blob = await new Promise<Blob>((resolve,reject)=>canvas.toBlob(result=>result ? resolve(result) : reject(new Error('无法生成 PNG 图片')),'image/png'))
  download(blob,filename(view,'png'))
}

function page() {
  const canvas = document.createElement('canvas')
  canvas.width = 1600; canvas.height = 1131
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#071426'; ctx.fillRect(0,0,1600,1131)
  ctx.fillStyle = '#78d6ff'; ctx.fillRect(82,77,1436,5)
  return {canvas,ctx}
}

function title(ctx:CanvasRenderingContext2D, text:string, subtitle:string) {
  ctx.fillStyle = '#eaf4ff'; ctx.font = 'bold 53px "Microsoft YaHei", sans-serif'; ctx.fillText(text,90,170)
  ctx.fillStyle = '#9abbd4'; ctx.font = '26px "Microsoft YaHei", sans-serif'; ctx.fillText(subtitle,92,220)
}

function wrap(ctx:CanvasRenderingContext2D, text:string, x:number, y:number, width:number, lineHeight:number) {
  let line = ''
  for (const char of text) {
    if (ctx.measureText(line+char).width > width && line) {ctx.fillText(line,x,y);y+=lineHeight;line=''}
    line+=char
  }
  if (line) ctx.fillText(line,x,y)
  return y+lineHeight
}

function footer(ctx:CanvasRenderingContext2D, number:number, url:string) {
  ctx.fillStyle = '#7894aa'; ctx.font = '19px "Microsoft YaHei", sans-serif'
  ctx.fillText('金沙江流域生态研究 · 当前视图简报',90,1070)
  ctx.textAlign = 'right'; ctx.fillText(String(number).padStart(2,'0'),1505,1070);ctx.textAlign='left'
  const address=new URL(url)
  ctx.font = '16px sans-serif';ctx.fillText('完整视图链接：'+address.origin+address.pathname+'（点击打开，分析条件完整保留）',90,1100,1330)
}

export async function exportPdf(view:ExportView) {
  const period = typeof view.year === 'number' ? `${view.year} 年` : view.year
  const [shot,{jsPDF}] = await Promise.all([screenshot(view.element),import('jspdf')])
  const pdf = new jsPDF({orientation:'landscape',unit:'px',format:[1600,1131],hotfixes:['px_scaling']})
  const add = (canvas:HTMLCanvasElement, index:number) => {
    if (index) pdf.addPage([1600,1131],'landscape')
    pdf.addImage(canvas.toDataURL('image/jpeg',.88),'JPEG',0,0,1600,1131,undefined,'FAST')
    pdf.link(85,1080,1430,40,{url:view.url})
  }
  {
    const {canvas,ctx} = page()
    ctx.fillStyle = '#64bcf0';ctx.font='bold 37px "Microsoft YaHei", sans-serif';ctx.fillText('金沙江智能生态评估',92,350)
    ctx.fillStyle = '#eaf4ff';ctx.font='bold 91px "Microsoft YaHei", sans-serif';wrap(ctx,view.topic+' · 视图简报',88,505,1370,110)
    ctx.fillStyle = '#adcce2';ctx.font='34px "Microsoft YaHei", sans-serif';wrap(ctx,`${view.station}  |  ${period}  |  ${view.metric}`,92,675,1380,45)
    ctx.font='25px "Microsoft YaHei", sans-serif';ctx.fillText(new Date().toLocaleString('zh-CN')+' · '+Intl.DateTimeFormat().resolvedOptions().timeZone,92,755)
    footer(ctx,1,view.url);add(canvas,0)
  }
  {
    const {canvas,ctx} = page();title(ctx,'当前视图','专题地图与面板截图')
    const area = {x:90,y:260,w:1420,h:755}
    const scale = Math.min(area.w/shot.width,area.h/shot.height)
    const w=shot.width*scale,h=shot.height*scale
    ctx.drawImage(shot,area.x+(area.w-w)/2,area.y+(area.h-h)/2,w,h)
    footer(ctx,2,view.url);add(canvas,1)
  }
  {
    const {canvas,ctx} = page();title(ctx,'指标表',`${view.topic} · ${view.station} · ${period}`)
    ctx.fillStyle='#17324e';ctx.fillRect(90,265,1420,62)
    ctx.fillStyle='#b3d5ec';ctx.font='bold 29px "Microsoft YaHei", sans-serif'
    ctx.fillText('指标',115,309);ctx.fillText('值',800,309);ctx.fillText('单位 / 说明',1110,309)
    const rowHeight = Math.min(55,680/Math.max(1,view.rows.length))
    view.rows.forEach(([name,value,unit],i)=>{
      const y=340+i*rowHeight
      ctx.fillStyle=i%2 ? '#10253b' : '#0c1d30';ctx.fillRect(90,y,1420,rowHeight-1)
      ctx.fillStyle='#e4f2ff';ctx.font=`${Math.min(25,rowHeight*.6)}px "Microsoft YaHei", sans-serif`
      ctx.fillText(name,115,y+rowHeight*.7,660);ctx.fillText(value,800,y+rowHeight*.7,280);ctx.fillText(unit,1110,y+rowHeight*.7,375)
    })
    footer(ctx,3,view.url);add(canvas,2)
  }
  {
    const {canvas,ctx} = page();title(ctx,'数据口径与来源','使用本简报时请同时核对原始档案和当前筛选条件')
    ctx.fillStyle='#d9eafa';ctx.font='29px "Microsoft YaHei", sans-serif'
    let y=310
    for (const [label,value] of [['专题与筛选',`${view.topic}；${view.station}；${period}；${view.metric}`],['处理口径',view.method],['数据来源',view.source],['生成时间',new Date().toLocaleString('zh-CN')+' · '+Intl.DateTimeFormat().resolvedOptions().timeZone]]) {
      ctx.fillStyle='#78d6ff';ctx.fillText(label,92,y)
      ctx.fillStyle='#d9eafa';y=wrap(ctx,value,92,y+50,1380,43)+43
    }
    footer(ctx,4,view.url);add(canvas,3)
  }
  if(view.run) {
    const run=view.run
    const means=run.comparison?.currentMeans ?? run.summary.means
    pdf.addPage([1600,1131],'landscape')
    pdf.setFont('helvetica');pdf.setTextColor(20,35,50)
    pdf.setFontSize(24);pdf.text('Reproducible assessment record',90,95)
    pdf.setFontSize(13)
    const lines=[`Run: ${run.run.id}`,`SHA-256: ${run.run.sha256}`,`Model: ${run.method}`,
      `Scope: ${run.scope.id}`,`BBox (W,S,E,N): ${run.run.parameters.bbox?.join(', ') ?? 'not applicable'}`,
      `Year: ${run.year ?? 'ledger baseline'}; comparison: ${run.comparison?.year ?? 'none'}; scenario: ${run.scenario.id}`,
      `Support: equal-weight station samples; valid ${run.summary.count}/${run.summary.eligible}; not area statistics`,
      'EEI is an empirical score without a fixed maximum of 100. Model is not independently calibrated.',
      ...run.metricDefinitions.map(metric=>`${metric.id}: ${means?.[metric.id] ?? 'no data'}${run.comparison?.delta ? ' | paired delta: '+(run.comparison.delta[metric.id] ?? 'no data') : ''}`),
      'Archive: download the matching evidence JSON for exact inputs, outputs, method and integrity verification.']
    lines.forEach((line,index)=>pdf.text(line,90,145+index*27))
    pdf.setProperties({title:view.topic,subject:'Run '+run.run.sha256,creator:'Jinsha Workbench'})
  }
  pdf.save(filename(view,'pdf'))
}
