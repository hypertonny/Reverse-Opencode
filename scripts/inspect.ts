import fs from "node:fs";

const bin = fs.readFileSync("C:/Users/sojo/AppData/Roaming/npm/node_modules/opencode-ai/bin/opencode.exe");
const str = bin.toString("binary");

const zenUrls = str.match(/https?:\/\/[a-zA-Z0-9.\-_/:]*zen[a-zA-Z0-9.\-_/:]*/g) ?? [];
console.log("Zen URLs:", [...new Set(zenUrls)]);

const freeTier = str.match(/.{0,100}FreeTierError.{0,100}/g) ?? [];
console.log("FreeTier snippets:", [...new Set(freeTier)].slice(0, 5));

const agentPrompt = str.match(/You are OpenCode.{0,150}/g) ?? [];
console.log("Agent prompts:", [...new Set(agentPrompt)].slice(0, 5));
