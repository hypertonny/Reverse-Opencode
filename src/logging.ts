import { mkdirSync, appendFileSync, existsSync, statSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { LOG_FILE, LOG_MAX_BYTES, costUSD, hasPrice } from "./config.ts";

export type LogEntry = {
  ts: string;
  request_id: string;
  client_model: string;
  upstream_model: string;
  upstream_kind: string;
  effort?: string;
  stream: boolean;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  /** true when the model has no price entry — cost_usd is then 0/unknown. */
  cost_unknown?: boolean;
  duration_ms: number;
  status: number;
  upstream_status?: number;
  upstream_error_type?: string;
  error?: string;
};

function rotateIfNeeded() {
  try {
    if (LOG_MAX_BYTES <= 0 || !existsSync(LOG_FILE)) return;
    if (statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      renameSync(LOG_FILE, LOG_FILE + ".1");
    }
  } catch { /* rotation is best-effort */ }
}

export function logRequest(e: LogEntry) {
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    rotateIfNeeded();
    appendFileSync(LOG_FILE, JSON.stringify(e) + "\n");
  } catch { /* logging must never crash */ }
  const cost = e.cost_unknown ? " cost?" : e.cost_usd ? ` $${e.cost_usd.toFixed(5)}` : "";
  console.log(
    `[${e.ts}] [${e.request_id.slice(0, 8)}] ${e.client_model} -> ${e.upstream_model} (${e.upstream_kind}${e.effort ? "#" + e.effort : ""}) ${e.input_tokens}in/${e.output_tokens}out${cost} ${e.duration_ms}ms status=${e.status}${e.error ? " ERR:" + e.error : ""}`,
  );
}

export function usageCost(upstreamModel: string, inTok: number, outTok: number) {
  return { cost: costUSD(upstreamModel, inTok, outTok), unknown: !hasPrice(upstreamModel) };
}
