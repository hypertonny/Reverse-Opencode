import fs from "node:fs";

const bin = fs.readFileSync("C:/Users/sojo/AppData/Roaming/npm/node_modules/opencode-ai/bin/opencode.exe");
const str = bin.toString("binary");

const idx = str.indexOf('name:"explore"');
if (idx !== -1) {
  const snippet = str.slice(idx - 100, idx + 800).replace(/[\x00-\x1F\x7F-\xFF]/g, ".");
  console.log("Snippet around explore agent:\n", snippet);
}
