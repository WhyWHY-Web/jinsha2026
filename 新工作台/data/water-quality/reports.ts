export type Level = 1 | 2 | 3 | 4 | 5

export const sichuanReports = {
  annual:'https://sthjt.sc.gov.cn/sthjt/c103945/2024/1/16/f1a36fe441ad41408574fa5de8d449c0/files/%E9%99%84%E4%BB%B6.pdf',
  january:'https://sthjt.sc.gov.cn/sthjt/c103945/2024/2/21/b691e16c4a214e1d97682d878b865b90/files/%E9%99%84%E4%BB%B6%E4%B8%8B%E8%BD%BD.pdf',
  winter:'https://sthjt.sc.gov.cn/sthjt/c103945/2024/3/19/b23e1cc4e672487db54a14ef8e422e0a/files/%E9%99%84%E4%BB%B6%E4%B8%8B%E8%BD%BD.pdf',
  half:'https://sthjt.sc.gov.cn/sthjt/c103945/2024/7/25/778e290c8ada4e5c9ed74725a12f4a34/files/%E9%99%84%E4%BB%B6%E4%B8%8B%E8%BD%BD.pdf',
  summer:'https://sthjt.sc.gov.cn/sthjt/c103945/2024/9/12/b88145051e784a4dbc6146211cc03b23/files/%E9%99%84%E4%BB%B6%E4%B8%8B%E8%BD%BD.pdf'
}

export const sections = [
  { id:'jinjiang', name:'金江', river:'金沙江', area:'攀枝花市', reportRow:67 },
  { id:'heishui', name:'黑水河河口', river:'黑水河', area:'凉山州', reportRow:68 },
  { id:'jinshazhen', name:'雷波县金沙镇', river:'金沙江', area:'凉山州', reportRow:69 },
  { id:'cangfang', name:'仓房电站', river:'金阳河', area:'凉山州', reportRow:70 },
  { id:'layimu', name:'溜筒河拉一木', river:'溜筒河', area:'凉山州', reportRow:71 },
  { id:'xixi', name:'西溪河大桥', river:'西溪河', area:'凉山州', reportRow:72 },
  { id:'baoning', name:'宝宁村', river:'金沙江', area:'宜宾市', reportRow:76 },
  { id:'mamingxi', name:'马鸣溪', river:'金沙江', area:'宜宾市', reportRow:77 }
] as const

type Group = keyof typeof sichuanReports
type Classifications = readonly [Level, Level, Level, Level, Level, Level, Level, Level]
type Snapshot = { group: Group; year:number; values:Classifications }
const archives: Snapshot[] = [
  { group:'half', year:2024, values:[1,2,1,2,2,1,1,2] },
  { group:'half', year:2023, values:[1,2,1,2,2,2,1,2] },
  { group:'summer', year:2024, values:[1,2,1,2,2,2,2,2] },
  { group:'summer', year:2023, values:[2,2,1,2,2,2,1,2] },
  { group:'winter', year:2024, values:[1,2,1,2,2,2,1,2] },
  { group:'winter', year:2023, values:[1,2,1,2,2,1,2,2] },
  { group:'january', year:2024, values:[2,2,2,2,2,2,1,2] },
  { group:'january', year:2023, values:[1,2,1,2,2,1,1,2] },
  { group:'annual', year:2023, values:[2,2,1,2,2,2,2,2] },
  { group:'annual', year:2022, values:[2,2,1,2,2,2,2,2] }
]

const periodLabels: Record<Group,string> = {
  annual:'全年', january:'1 月', winter:'1–2 月', half:'1–6 月', summer:'1–8 月'
}

export const snapshots = archives.map(snapshot=>({
  ...snapshot, label:`${snapshot.year} 年 ${periodLabels[snapshot.group]}`, source:sichuanReports[snapshot.group]
}))
