// agent-purge × magpie —— 网关层人设注入。
//
// 这是 magpie 的异步 gateway request hook（Bun，每请求一次）。挂上之后，凡是经过 magpie
// 网关的 agent 请求（Claude Code、Codex、OpenCode、pi…），system 段都按 agent-purge 的
// 当前人设与模式改写。人设与模式直接读 agent-purge 的数据目录：在 agent-purge 里换人设，
// 下一个请求就换，不用重装插件（不用重启 magpie）。
//
// 模式与 agent-purge 一致：
//   off      不动请求
//   strict   整段 system 换成人设（最干净；工具说明也一起没了，harness 可能变笨）
//   append   人设挂在最前，宿主 system 原样保留
//   replace  人设挂在最前 + 宿主 system 里报名字的句子删掉（近似；网关手里只有文本，
//            没有各家启动参数，比不上 agent-purge 那套 per-harness 处理，想要干净就用 strict）
//
// 选项（magpie plugin options agent-purge '{"mode":"append"}'）：
//   mode     覆盖 state.json 里的模式
//   persona  用哪个人设 id（默认 state.json 的当前人设）
//   agents   只对这些 magpie agent 生效，如 ["claude","codex"]；不给 = 全部
//   inlinePersonas  页面导入的人设 [{id,name,text}]；和 personas/<id>.md 同名时以它为准
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as abs } from "node:path";

const MODES = ["strict", "replace", "append", "off"];
const SEP = "\n\n";

function dataHome() {
	const env = process.env.AGENT_PURGE_HOME?.trim();
	if (!env) return join(homedir(), ".agent-purge");
	return isAbsolute(env) ? env : abs(env);
}

/** frontmatter 绝不能进 prompt（agent-purge 落盘时也是这么剥的） */
const stripFront = (raw) => String(raw).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();

// 每个请求只有 1 秒预算，所以只在 state.json / 人设文件的 mtime 变了才读盘。
let cache = { key: "", value: { mode: "off", text: "" } };

function current(personaId, inline = []) {
	const home = dataHome();
	const stateFile = join(home, "state.json");
	let sst = null;
	try {
		sst = statSync(stateFile);
	} catch {
		/* 没装过 agent-purge：按 off 处理 */
	}

	let mode = "off";
	let active = null;
	if (sst) {
		try {
			const state = JSON.parse(readFileSync(stateFile, "utf8"));
			active = typeof state?.persona === "string" ? state.persona : null;
			if (MODES.includes(state?.default?.mode)) mode = state.default.mode;
		} catch {
			/* 坏文件不动它，请求原样放行 */
		}
	}

	const id = personaId || active;
	if (!id) return { mode, text: "" };
	// 页面导入的人设存在 options 里：命中就不读盘（每个请求只有 1 秒预算）
	const hit = inline.find((p) => p && typeof p === "object" && p.id === id && typeof p.text === "string" && p.text.trim());
	if (hit) return { mode, text: stripFront(hit.text) };
	const file = join(home, "personas", `${id}.md`);
	let pst = null;
	try {
		pst = statSync(file);
	} catch {
		return { mode, text: "" };
	}

	const key = `${sst?.mtimeMs}:${sst?.size}|${file}:${pst.mtimeMs}:${pst.size}`;
	if (key !== cache.key) cache = { key, value: { text: stripFront(readFileSync(file, "utf8")) } };
	return { mode, text: cache.value.text };
}

// replace 的近似剔除：只删「一行里同时有自称 + 点名模型/厂商」的行。
const SELF = /^\s*(?:You are|You're|你是|您是|我(?:是|现在扮演|就是))/i;
const NAMED =
	/(Claude|ChatGPT|GPT-?[45]|Gemini|Codex|Copilot|DeepSeek|Qwen|Kimi|GLM|Cursor|Windsurf|AI (?:assistant|model)|语言模型|助手)/i;
const stripIdentity = (text) =>
	String(text ?? "")
		.split("\n")
		.filter((line) => !(SELF.test(line) && NAMED.test(line)))
		.join("\n")
		.trim();

const textOf = (content) => {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("");
	return "";
};

// 四种 agent API 的 system 落点。块结构（含 cache_control）尽量原地保留：
// 拍平成字符串会让客户端自己的缓存断点失效，每一轮都重新计费。
function anthropicSystem(body, persona, mode) {
	const cur = body.system;
	const blocks =
		typeof cur === "string"
			? cur
				? [{ type: "text", text: cur }]
				: []
			: Array.isArray(cur)
				? cur.filter((b) => b && typeof b === "object").map((b) => ({ ...b }))
				: [];
	if (mode === "strict") {
		body.system = [{ type: "text", text: persona }];
		return;
	}
	if (mode === "replace") for (const b of blocks) if (typeof b.text === "string") b.text = stripIdentity(b.text);
	body.system = [{ type: "text", text: persona }, ...blocks];
}

function chatSystem(body, persona, mode) {
	if (!Array.isArray(body.messages)) body.messages = [];
	const msgs = body.messages;
	const i = msgs.findIndex((m) => m?.role === "system" || m?.role === "developer");
	if (mode === "strict") {
		if (i >= 0) msgs[i] = { role: msgs[i].role, content: persona };
		else msgs.unshift({ role: "system", content: persona });
		return;
	}
	if (i < 0) {
		msgs.unshift({ role: "system", content: persona });
		return;
	}
	const m = msgs[i];
	const host = mode === "replace" ? stripIdentity(textOf(m.content)) : textOf(m.content);
	m.content = host ? persona + SEP + host : persona;
}

function responsesSystem(body, persona, mode) {
	const host = typeof body.instructions === "string" ? body.instructions : "";
	if (mode === "strict") {
		body.instructions = persona;
		return;
	}
	const keep = mode === "replace" ? stripIdentity(host) : host;
	body.instructions = keep ? persona + SEP + keep : persona;
}

function geminiSystem(body, persona, mode) {
	const key = body.systemInstruction ? "systemInstruction" : body.system_instruction ? "system_instruction" : "systemInstruction";
	const cur = body[key];
	const parts = Array.isArray(cur?.parts) ? cur.parts.filter((p) => p && typeof p === "object").map((p) => ({ ...p })) : [];
	if (mode === "strict") {
		body[key] = { parts: [{ text: persona }] };
		return;
	}
	if (mode === "replace") for (const p of parts) if (typeof p.text === "string") p.text = stripIdentity(p.text);
	body[key] = { ...(cur ?? {}), parts: [{ text: persona }, ...parts] };
}

const REWRITE = { anthropic: anthropicSystem, chat: chatSystem, responses: responsesSystem, gemini: geminiSystem };

/** magpie 每请求调一次：返回对象 = 用改过的请求，返回 undefined = 原样放行。 */
export async function onRequest(body, ctx) {
	try {
		if (!body || typeof body !== "object") return;
		const opt = ctx?.options && typeof ctx.options === "object" ? ctx.options : {};
		const inline = Array.isArray(opt.inlinePersonas) ? opt.inlinePersonas : [];
		const cfg = current(typeof opt.persona === "string" ? opt.persona : null, inline);
		const mode = MODES.includes(opt.mode) ? opt.mode : cfg.mode;
		if (mode === "off" || !cfg.text) {
			ctx?.report?.("skipped", 0);
			return;
		}
		const agents = Array.isArray(opt.agents) ? opt.agents : [];
		if (agents.length && !agents.includes(ctx.agent)) {
			ctx?.report?.("skipped", 0);
			return;
		}
		const rewrite = REWRITE[ctx?.protocol];
		if (!rewrite) {
			ctx?.report?.("unavailable", 0);
			return;
		}
		rewrite(body, cfg.text, mode);
		ctx?.report?.("ready", cfg.text.length);
		return body;
	} catch {
		// fail-open：改不动就原样放行，别把 agent 的请求弄挂
		try {
			ctx?.report?.("invalid", 0);
		} catch {
			/* report 本身失败也不能影响放行 */
		}
	}
}
