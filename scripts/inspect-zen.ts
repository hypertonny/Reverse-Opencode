import fs from "node:fs";

const bin = fs.readFileSync("C:/Users/sojo/AppData/Roaming/npm/node_modules/opencode-ai/bin/opencode.exe");
const str = bin.toString("binary");

const idx = str.indexOf("https://opencode.ai/zen/v1");
if (idx !== -1) {
  console.log("Found at index:", idx);
  // print 500 bytes before and after
  const snippet = str.slice(Math.max(0, idx - 500), idx + 500);
  // clean non-printable ascii
  const cleaned = snippet.replace(/[\x00-\x1F\x7F-\xFF]/g, ".");
  console.log("Snippet around zen URL:\n", cleaned);
}
