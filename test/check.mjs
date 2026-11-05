import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const files = readdirSync("src", { recursive: true }).filter((file) => file.endsWith(".js")).sort();
for (const file of files) execFileSync(process.execPath, ["--check", `src/${file}`], { stdio: "inherit" });
console.log(`Syntax PASS: ${files.length} JavaScript files`);
