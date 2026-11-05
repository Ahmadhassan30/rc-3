export type EvidenceStateHint =
  | "SUPPORTED"
  | "MENTIONED_ONLY"
  | "RELATED_ONLY"
  | "NOT_FOUND"
  | "UNCERTAIN";

export interface Passage {
  id: string;
  candidateId: string;
  section: "experience" | "project" | "skills" | "education";
  text: string;
  evidenceStateHint: EvidenceStateHint;
}

export interface Query {
  id: string;
  text: string;
  relevantPassageIds: string[];
  hardNegativePassageIds: string[];
  rationale: string;
}

export interface Dataset {
  version: string;
  frozenAt: string;
  description: string;
  passages: Passage[];
  queries: Query[];
}

export interface ModelConfig {
  key: "bge-small-en-v1.5" | "all-MiniLM-L6-v2";
  modelId: string;
  pooling: "cls" | "mean";
  queryPrefix: string;
  documentPrefix: string;
  normalize: true;
  expectedDimensions: 384;
}

export interface RankedPassage {
  passageId: string;
  score: number;
  relevant: boolean;
  hardNegative: boolean;
}

export interface QueryResult {
  queryId: string;
  reciprocalRank: number;
  recallAt1: number;
  recallAt3: number;
  top: RankedPassage[];
}

export interface ModelResult {
  model: ModelConfig;
  dimensions: number;
  metrics: {
    recallAt1: number;
    recallAt3: number;
    mrr: number;
    hitAt1: number;
    hitAt3: number;
  };
  timingsMs: {
    moduleImport: number;
    modelLoad: number;
    firstInference: number;
    corpusBatch: number;
    queryBatch: number;
    warmMedian: number;
    warmP95: number;
    warmRepetitions: number;
  };
  memoryMiB: {
    rssBeforeImport: number;
    rssAfterLoad: number;
    rssAfterInference: number;
    loadDelta: number;
    inferenceDelta: number;
  };
  queryResults: QueryResult[];
}
