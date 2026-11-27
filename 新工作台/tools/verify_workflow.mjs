import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const sourceData = fileURLToPath(new URL('../../系统/data/', import.meta.url))
const scratch = await mkdtemp(join(tmpdir(), 'jinsha-workflow-test-'))
const probe = createServer()
probe.listen(0, '127.0.0.1')
await once(probe, 'listening')
const { port } = probe.address()
await new Promise(resolve => probe.close(resolve))
const origin = 'http://127.0.0.1:' + port
const child = spawn(process.execPath, ['server/index.ts'], {
  cwd: root,
  windowsHide: true,
  env: { ...process.env, JINSHA_WORKBENCH_PORT: String(port),
    JINSHA_WORKBENCH_STATE: join(scratch, 'state.sqlite'), JINSHA_AGENT_MODEL: 'off' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
child.stdout.on('data', data => { output += data })
child.stderr.on('data', data => { output += data })
const request = async (path, payload) => {
  const response = await fetch(origin + path, payload === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(payload),
  })
  return { status: response.status, data: await response.json() }
}
const climateHash = async () => createHash('sha256')
  .update(await readFile(join(sourceData, 'climate_annual.json'))).digest('hex')

try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Service startup timed out. ' + output)), 15000)
    const finish = () => {
      if (!output.includes(origin)) return
      clearTimeout(timer)
      resolve()
    }
    child.stdout.on('data', finish)
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Service exited ' + code + '. ' + output)) })
    finish()
  })
  const originalHash = await climateHash()
  const before = await request('/api/ecology/assess?scope=station:shigu&year=2025')
  assert.equal(before.status, 200)
  const original = before.data.stations[0].inputs.precip
  const first = { stationIds: ['shigu'], year: 2025, field: 'precipitation', value: 900,
    source: 'Isolated regression fixture', reason: 'Validate concurrent edits and undo' }
  const preview = await request('/api/ecology/amendments/preview', first)
  assert.equal(preview.data.previous[0].value, original)
  const writes = await Promise.all([first, { ...first, value: 850 }].map(draft =>
    request('/api/ecology/amendments', { ...draft, revision: preview.data.revision })))
  assert.deepEqual(writes.map(result => result.status).sort(), [201, 409])
  const accepted = writes.find(result => result.status === 201).data
  const entry = accepted.entries[0]
  const changed = await request('/api/ecology/assess?scope=station:shigu&year=2025')
  assert.equal(changed.data.stations[0].inputs.precip, entry.value)
  assert.deepEqual(changed.data.stations[0].inputs.amendedFields, ['precip'])
  const series = await request('/api/series?metric=precipitation&station=shigu&from=2025&to=2025')
  assert.equal(series.data.values[0].value, entry.value)
  const undo = await request('/api/ecology/amendments/' + entry.id + '/revert', { revision: accepted.revision })
  assert.equal(undo.status, 200)
  const restored = await request('/api/ecology/assess?scope=station:shigu&year=2025')
  assert.equal(restored.data.stations[0].inputs.precip, original)
  assert.equal(await climateHash(), originalHash)
  assert.equal((await request('/api/ecology/amendments', { ...first, value: -1, revision: undo.data.revision })).status, 400)
  const agent = await request('/api/ecology/agent', { prompt: '定位石鼓站' })
  assert.equal(agent.data.action.stationId, 'shigu')
  assert.equal(agent.data.mode, 'local')
  const soil = await request('/api/ecology/agent', { prompt: '查看表层土壤有机碳含量' })
  assert.match(soil.data.answer, /g\/kg/)
  console.log('Verified conflicting edits, recalculation, chart overlay, undo, source integrity and local agent tools.')
} finally {
  if (child.exitCode === null) {
    const closed = once(child, 'exit')
    child.kill()
    await closed
  }
  assert.equal(dirname(resolve(scratch)), resolve(tmpdir()))
  await rm(scratch, { recursive: true, force: true })
}
