export interface EngineeringProject {
  id: string;
  name: string;
  cascade: number;
  region: string;
  installedMW: number;
  designLevelM: number;
  firstOperationYear: number;
  annualGeneration2023: number;
}

export type DispatchKind = "生态试验" | "管理文件" | "试验总结";

export interface DispatchEntry {
  id: string;
  date: string;
  dateLabel: string;
  title: string;
  kind: DispatchKind;
  description: string;
  projects: string[];
  source: string;
  url: string;
}

export interface EngineeringCatalog {
  baselineYear: number;
  issuer: string;
  sourceUrl: string;
  projects: EngineeringProject[];
  dispatch: DispatchEntry[];
}
