import fs from "node:fs";

const bin = fs.readFileSync("C:/Users/sojo/AppData/Roaming/npm/node_modules/opencode-ai/bin/opencode.exe");
const str = bin.toString("binary");

// Search for references to Na in function calls: Na, or Na+ or [Na
const regex = /[a-zA-Z0-9_$]+\([^)]*Na[^)]*\)|\[[^\]]*Na[^\]]*\]/g;
const matches = str.match(regex) ?? [];
console.log("References to Na:", matches.slice(0, 10));
