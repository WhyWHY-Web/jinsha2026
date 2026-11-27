import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EngineeringCatalog } from "../data/engineering/types.ts";

export async function getEngineeringCatalog(dataDir: string): Promise<EngineeringCatalog> {
  const archive = await readFile(join(dataDir, "engineering", "catalog.json"), "utf8");
  return JSON.parse(archive) as EngineeringCatalog;
}
