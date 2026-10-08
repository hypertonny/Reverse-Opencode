import fs from "node:fs";

const bin = fs.readFileSync("C:/Users/sojo/AppData/Roaming/npm/node_modules/opencode-ai/bin/opencode.exe");
const str = bin.toString("binary");

const target = "var Na=`You are OpenCode";
const idx = str.indexOf(target);
if (idx !== -1) {
  // Let's see what happens after Na
  const snippet = str.slice(idx, idx + 4000);
  const endIdx = snippet.indexOf(";");
  console.log("Length of Na:", endIdx);
  const after = snippet.slice(endIdx, endIdx + 1500).replace(/[\x00-\x1F\x7F-\xFF]/g, ".");
  console.log("After Na definition:\n", after);
}
