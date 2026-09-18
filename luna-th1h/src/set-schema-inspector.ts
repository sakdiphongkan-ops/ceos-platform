import fs from "node:fs";
import path from "node:path";

const file = process.env.SET_RAW_FILE ?? process.argv[2];
if (!file) {
  console.error("Usage: SET_RAW_FILE=/path/file npm run inspect:set");
  process.exit(1);
}

const sample = fs.readFileSync(file, "utf8").split(/\r?\n/).slice(0, 120);
const candidates = [",", "\t", "|", ";"];
const score = (line: string, d: string) => {
  let quoted = false, count = 0;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === d && !quoted) count++;
  }
  return count;
};

const ranked = candidates
  .map(d => ({ delimiter: d === "\t" ? "TAB" : d, score: sample.slice(0, 40).reduce((s, l) => s + score(l, d), 0) }))
  .sort((a,b) => b.score-a.score);

const delimiter = ranked[0]?.score ? ranked[0].delimiter : "UNKNOWN";
const rawDelimiter = delimiter === "TAB" ? "\t" : delimiter;

console.log(JSON.stringify({
  file: path.resolve(file),
  bytes: fs.statSync(file).size,
  lines_sampled: sample.length,
  delimiter_candidates: ranked,
  detected_delimiter: rawDelimiter,
  first_non_empty_lines: sample.filter(Boolean).slice(0, 12)
}, null, 2));
