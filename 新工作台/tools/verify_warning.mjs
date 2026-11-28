import assert from 'node:assert/strict'
import { indicatorMarks, screenWarnings } from '../src/warning.ts'
import { compactLabel } from '../src/map-labels.ts'

const stations = Array.from({length:20},(_,index)=>({
  id:String(index), name:'站'+index, lon:100, lat:28, type:'水文站', zone:'测试区',
  elevation:null, temp:null, precip:index*10, cover:null, assessment:null
}))
const rows = screenWarnings(stations)
assert.deepEqual([4,3,2,1].map(level=>rows.filter(row=>row.readings.precipitation.level===level).length),[1,1,1,1])
assert.equal(rows[0].main,'precipitation')
assert.equal(indicatorMarks(rows,'precipitation')['0'].reading,'0 mm')
assert.equal(screenWarnings(stations.map(station=>({...station,precip:100}))).every(row=>row.readings.precipitation.level===0),true)
assert.equal(screenWarnings(stations.map(station=>({...station,precip:NaN}))).every(row=>row.level===5),true)
const hot = screenWarnings(stations.map((station,index)=>({...station,precip:null,temp:index})))
assert.equal(hot.at(-1).readings.temperature.level,4)
assert.equal(compactLabel(7,24,false,false),false)
assert.equal(compactLabel(7,25,false,false),true)
assert.equal(compactLabel(7,25,false,true),false)
assert.equal(compactLabel(5.9,0,false,true),true)
assert.equal(compactLabel(7,0,true,false),true)
console.log('Warning screening checks passed')
