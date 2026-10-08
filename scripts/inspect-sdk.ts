import fs from "node:fs";

const bin = fs.readFileSync("C:/Users/sojo/AppData/Roaming/npm/node_modules/opencode-ai/bin/opencode.exe");
const str = bin.toString("binary");

const idx = str.indexOf("@ai-sdk/openai-compatible");
if (idx !== -1) {
  const snippet = str.slice(Math.max(0, idx - 1000), idx + 1000);
  const cleaned = snippet.replace(/[\x00-\x1F\x7F-\xFF]/g, ".");
  console.log("Snippet around @ai-sdk/openai-compatible:\n", cleaned);
}
