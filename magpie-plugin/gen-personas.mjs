// 生成 page/personas.js：插件页读不到磁盘也不能 fetch，人设清单只能静态带进去。
//   node magpie-plugin/gen-personas.mjs     （增删人设后重跑一次）
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const env = process.env.AGENT_PURGE_HOME?.trim();
const home = !env ? join(homedir(), ".agent-purge") : isAbsolute(env) ? env : resolve(env);
const dir = join(home, "personas");

const field = (fm, k) =>
	fm
		.match(new RegExp(`^${k}:\\s*(.+)$`, "m"))?.[1]
		?.trim()
		.replace(/^["']|["']$/g, "") ?? "";

const list = readdirSync(dir)
	.filter((f) => f.endsWith(".md") && f !== "active.md") // active.md 是 agent-purge 自己同步的副本，不是可选人设
	.map((f) => {
		const fm = readFileSync(join(dir, f), "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
		return { id: field(fm, "id") || f.replace(/\.md$/, ""), name: field(fm, "name"), description: field(fm, "description") };
	})
	.sort((a, b) => a.id.localeCompare(b.id));

writeFileSync(new URL("./page/personas.js", import.meta.url), `window.PERSONAS = ${JSON.stringify(list, null, "\t")};\n`);
console.log(`personas.js ← ${list.length} 个：${list.map((p) => p.id).join(", ")}`);
