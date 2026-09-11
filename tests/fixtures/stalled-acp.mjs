// Hold a model probe in initialization, even after stdin closes. No model or
// account is contacted. The lifecycle test owns and cleans up this process.
import { renameSync, writeFileSync } from "node:fs";

const pidFile = process.argv[2];
writeFileSync(`${pidFile}.tmp`, String(process.pid));
renameSync(`${pidFile}.tmp`, pidFile);
process.stdin.resume();
setInterval(() => {}, 1000);
