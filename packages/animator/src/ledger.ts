import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

export interface Ledger {
  day: string;
  spentUsd: number;
  calls: number;
  tasksDone: number;
  byModel: Record<string, { calls: number; usd: number; inputTokens: number; outputTokens: number }>;
}

const today = () => new Date().toISOString().slice(0, 10);

function fresh(): Ledger {
  return { day: today(), spentUsd: 0, calls: 0, tasksDone: 0, byModel: {} };
}

export class SpendLedger {
  private data: Ledger;

  constructor() {
    this.data = fresh();
    if (existsSync(config.ledgerFile)) {
      try {
        const saved = JSON.parse(readFileSync(config.ledgerFile, "utf8")) as Ledger;
        if (saved.day === today()) this.data = saved;
      } catch {
        /* fichier illisible : on repart de zéro */
      }
    }
  }

  private rollover() {
    if (this.data.day !== today()) {
      this.data = fresh();
      this.save();
    }
  }

  private save() {
    mkdirSync(dirname(config.ledgerFile), { recursive: true });
    writeFileSync(config.ledgerFile, JSON.stringify(this.data, null, 2));
  }

  record(model: string, usd: number, inputTokens: number, outputTokens: number) {
    this.rollover();
    this.data.spentUsd += usd;
    this.data.calls += 1;
    const m = (this.data.byModel[model] ??= { calls: 0, usd: 0, inputTokens: 0, outputTokens: 0 });
    m.calls += 1;
    m.usd += usd;
    m.inputTokens += inputTokens;
    m.outputTokens += outputTokens;
    this.save();
  }

  recordTask() {
    this.rollover();
    this.data.tasksDone += 1;
    this.save();
  }

  get snapshot(): Ledger {
    this.rollover();
    return this.data;
  }

  get exhausted() {
    this.rollover();
    return this.data.spentUsd >= config.dailyCapUsd;
  }

  get tasksExhausted() {
    this.rollover();
    return this.data.tasksDone >= config.maxTasksPerDay;
  }
}
