import fs from "node:fs";

const bin = fs.readFileSync("C:/Users/sojo/AppData/Roaming/npm/node_modules/opencode-ai/bin/opencode.exe");
const str = bin.toString("binary");

// Search for "The default agent"
const idx = str.indexOf("The default agent");
if (idx !== -1) {
  const snippet = str.slice(Math.max(0, idx - 500), idx + 800);
  const cleaned = snippet.replace(/[\x00-\x1F\x7F-\xFF]/g, ".");
  console.log("Snippet around default agent:\n", cleaned);
}
