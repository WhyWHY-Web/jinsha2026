import type { IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

type Field = "temperature" | "precipitation";
type Amendment = {
  stationIds: string[];
  field: Field;
  year: number;
  value: number;
  source: string;
  reason: string;
};
type JournalEntry = Amendment & { id: number; createdAt: string; reverted: boolean };
type JournalRow = {
  id: number; target_ids: string; field: Field; year: number; value: number;
  source: string; reason: string; created_at: string; reverted: number;
};
type ClimateRow = { station: string; year: number; temp_c: number | null; precip_mm: number | null };
type Station = { id: string; name: string; en?: string; lon: number; lat: number; zone?: string };
type Revision = { revision: number };
export type ClimateOverrides = Record<string, {temp?: number; precip?: number}>;

const fields = {
  temperature: { climate: "temp_c", key: "temp", name: "年均气温", unit: "°C", low: -65, high: 60 },
  precipitation: { climate: "precip_mm", key: "precip", name: "年降水量", unit: "mm", low: 0, high: 12000 },
} as const;

export class WorkflowError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
    throw new WorkflowError("请求需使用 JSON", 415);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length;
    if (size > 16384) throw new WorkflowError("提交内容过长", 413);
    chunks.push(part);
  }
  let data: unknown;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new WorkflowError("无法解析 JSON");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new WorkflowError("需要一个 JSON 对象");
  return data as Record<string, unknown>;
}

function fieldFor(value: unknown): value is Field {
  return value === "temperature" || value === "precipitation";
}

function checkedYear(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1900 && value <= new Date().getUTCFullYear();
}

function requiredText(value: unknown, label: string, max: number) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new WorkflowError(label + "须为 1–" + max + " 个字符");
  }
  return value.trim();
}

function amendmentFrom(input: Record<string, unknown>, stations: Station[], climate:ClimateRow[]): Amendment {
  const { stationIds, field, year, value } = input;
  if (!Array.isArray(stationIds) || !stationIds.length || stationIds.length > stations.length
      || stationIds.some(id => typeof id !== "string" || !stations.some(station => station.id === id))) {
    throw new WorkflowError("请在流域台账中选择有效站点");
  }
  if (!checkedYear(year)) throw new WorkflowError("请输入有效的历史年份");
  if (!climate.some(row=>row.year===year)) throw new WorkflowError("该年份不在可评估的年度气候档案中");
  if (!fieldFor(field)) throw new WorkflowError("可修正字段为年均气温和年降水量");
  const { low, high, name, unit } = fields[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value < low || value > high) {
    throw new WorkflowError(name + "应在 " + low + "–" + high + " " + unit + " 范围内");
  }
  return {
    stationIds: [...new Set(stationIds as string[])], field, year, value,
    source: requiredText(input.source, "资料来源", 300), reason: requiredText(input.reason, "修正说明", 600),
  };
}

function revisionFrom(input: Record<string, unknown>): number {
  if (typeof input.revision !== "number" || !Number.isSafeInteger(input.revision) || input.revision < 0) {
    throw new WorkflowError("请先获取当前版本后提交");
  }
  return input.revision;
}

function fromRow(row: JournalRow): JournalEntry {
  return {
    id: row.id, stationIds: JSON.parse(row.target_ids), field: row.field, year: row.year, value: row.value,
    source: row.source, reason: row.reason, createdAt: row.created_at, reverted: Boolean(row.reverted),
  };
}

export function createWorkflow(root: string, databasePath: string) {
  let db: DatabaseSync | undefined;
  let initializedSources: Promise<{ stations: Station[]; climate: ClimateRow[] }> | undefined;

  function database() {
    if (db) return db;
    const opened = new DatabaseSync(databasePath);
    opened.exec(`
      PRAGMA busy_timeout = 3500;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS revisions (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO revisions VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS amendments (
        id INTEGER PRIMARY KEY, target_ids TEXT NOT NULL, field TEXT NOT NULL, year INTEGER NOT NULL,
        value REAL NOT NULL, source TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
        reverted INTEGER NOT NULL DEFAULT 0 CHECK(reverted IN (0,1)), reverted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS amendments_by_year ON amendments(year, reverted, id);
    `);
    db = opened;
    return opened;
  }

  function sources() {
    if (!initializedSources) {
      const json = async (name: string) => JSON.parse((await readFile(join(root, name), "utf8")).replace(/^\uFEFF/, ""));
      initializedSources = Promise.all([json("stations.json"), json("climate_annual.json")])
        .then(([registry, climate]) => ({ stations: registry.stations as Station[], climate: climate as ClimateRow[] }))
        .catch(error => { initializedSources = undefined; throw error; });
    }
    return initializedSources;
  }

  const revision = () => (database().prepare("SELECT revision FROM revisions WHERE singleton=1").get() as Revision).revision;

  function list() {
    return {
      revision: revision(),
      entries: (database().prepare("SELECT * FROM amendments ORDER BY id DESC LIMIT 100").all() as unknown as JournalRow[]).map(fromRow),
    };
  }

  function overrides(year: number): ClimateOverrides {
    const rows = database().prepare("SELECT * FROM amendments WHERE year=? AND reverted=0 ORDER BY id").all(year) as unknown as JournalRow[];
    const output: ClimateOverrides = Object.create(null);
    for (const row of rows.map(fromRow)) {
      for (const id of row.stationIds) {
        const entry = output[id] ?? (output[id] = {});
        entry[fields[row.field].key] = row.value;
      }
    }
    return output;
  }

  function stationSeries(id: string, field: Field) {
    const rows = database().prepare(`SELECT a.year, a.value FROM amendments AS a, json_each(a.target_ids) AS target
      WHERE a.reverted=0 AND a.field=? AND target.value=? ORDER BY a.id`).all(field,id) as Array<{year:number;value:number}>;
    return new Map(rows.map(row=>[row.year,row.value]));
  }

  function transact(expected: number, operation: (connection: DatabaseSync) => void) {
    const connection = database();
    connection.exec("BEGIN IMMEDIATE");
    try {
      if (revision() !== expected) throw new WorkflowError("记录已更新，请重新预览后提交", 409);
      operation(connection);
      connection.exec("UPDATE revisions SET revision=revision+1 WHERE singleton=1");
      connection.exec("COMMIT");
    } catch (error) {
      connection.exec("ROLLBACK");
      throw error;
    }
    return list();
  }

  async function preview(input: Record<string, unknown>) {
    const { stations, climate } = await sources();
    const change = amendmentFrom(input, stations, climate);
    const applied = overrides(change.year);
    const meta = fields[change.field];
    const previous = change.stationIds.map(id => {
      const name = stations.find(station => station.id === id)!.name;
      const original = climate.find(row => row.station === name && row.year === change.year)?.[meta.climate] ?? null;
      return { stationId: id, name, value: applied[id]?.[meta.key] ?? original };
    });
    return { revision: revision(), previous, count: previous.length };
  }

  async function commit(input: Record<string, unknown>) {
    const {stations,climate}=await sources();
    const change = amendmentFrom(input, stations, climate);
    return transact(revisionFrom(input), connection => {
      connection.prepare(`INSERT INTO amendments (target_ids, field, year, value, source, reason, created_at)
        VALUES (?,?,?,?,?,?,?)`).run(JSON.stringify(change.stationIds), change.field, change.year,
        change.value, change.source, change.reason, new Date().toISOString());
    });
  }

  function revert(id: number, input: Record<string, unknown>) {
    return transact(revisionFrom(input), connection => {
      const result = connection.prepare("UPDATE amendments SET reverted=1, reverted_at=? WHERE id=? AND reverted=0")
        .run(new Date().toISOString(), id);
      if (!result.changes) throw new WorkflowError("修正记录不存在或已经撤销", 404);
    });
  }

  return { list, preview, commit, revert, overrides, stationSeries, sources };
}
