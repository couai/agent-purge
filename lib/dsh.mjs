// dsh（DeepSeek Harness）的插件通道，三形态（desktop / web / headless）共用一套写法。
//
// 三个插件名，互不覆盖：
//   agent-purge          常驻注入：每次 assemble 读 state.json + active.md，off 即时生效
//   agent-purge-slash    会话内热切：只注册 /purge 命令，不碰系统提示词
//   agent-purge-session  一次性：persona 快照编译进源码，进程退出即删
//
// 三个 profile 都要装：paths 推导自 profile 的 dirname（src/index.js → package root），
// 所以包必须放在 <profile>/node_modules/<name> 下。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DSH_PROFILES = ["desktop", "web", "headless"];
export const RESIDENT = "agent-purge";
export const SLASH_RESIDENT = "agent-purge-slash";
export const SESSION = "agent-purge-session";

export const dshHome = () => process.env.DSH_HOME || join(homedir(), ".dsh");
export const profileDir = (p) => join(dshHome(), "profiles", p);
export const pluginDir = (p, name = RESIDENT) => join(profileDir(p), "node_modules", name);
const patchFile = (p) => join(profileDir(p), "cordis.patch.yml");

/**
 * dsh 自己建过的 profile（带 package.json）。
 * 不在这个名单里的目录绝不碰：PROFILE_TEMPLATES 里没有 desktop，我们写个
 * 只有 patch + node_modules 的空目录，dsh 启动时会判定 "profile desktop does not exist" 直接拒绝启动。
 * web / headless 虽然会自动 initProfile，但那是 dsh 的活，不是我们的。
 */
export function liveProfiles() {
	return DSH_PROFILES.filter((p) => existsSync(join(profileDir(p), "package.json")));
}

const mark = (name) => [`# >>> agent-purge:${name}`, `# <<< agent-purge:${name}`];

/** 这个 package.json 是 agent-purge 写的吗（别碰同名外来目录）。 */
const isOurs = (meta) => existsSync(meta) && /"?agentPurge"?\s*:\s*true/.test(readFileSync(meta, "utf8"));

/** 常驻插件：不编译人设，每次请求现读 state；off 就把宿主的返回值原样透传。 */
export function residentSource(root, activePath) {
	const state = join(root, "state.json").replace(/\\/g, "/");
	// active.md 是派生物，实际位置是 <root>/personas/active.md（由 createStore().materialize 给出）
	const active = String(activePath).replace(/\\/g, "/");
	return `// 由 agent-purge 生成；删掉本目录 + patch 段即取消。
import { readFileSync, appendFileSync } from "node:fs";
const STATE = ${JSON.stringify(state)};
const ACTIVE = ${JSON.stringify(active)};
const NAME = ${JSON.stringify(RESIDENT)};
// 一行一条的运行日志，出问题先看它。写失败静默。
const LOG = STATE.replace(/state\.json$/, "dsh.log");
function log(ev, extra) {
  try {
    appendFileSync(LOG, new Date().toISOString() + " " + PROFILE + " " + ev + (extra ? " " + extra : "") + "\\n");
  } catch { /* 只读环境不抛 */ }
}
// 自己在哪个 profile：<dsh>/profiles/<name>/node_modules/<pkg>/index.js
const PROFILE = (() => {
  try {
    const m = /[\\\\/]profiles[\\\\/]([^\\\\/]+)[\\\\/]/.exec(new URL(import.meta.url).pathname);
    return m ? decodeURIComponent(m[1]) : "";
  } catch {
    return "";
  }
})();
function cfg() {
  try {
    const st = JSON.parse(readFileSync(STATE, "utf8"));
    // 磁盘卸载后内存里的回调还在：armed 里没有 install 就当成已关闭
    const armed = st && st.armed && st.armed.dsh;
    if (!Array.isArray(armed) || !armed.includes("install")) return null;
    // dshProfiles：没设置过 = desktop/web/headless 全开；设了 = 只认列出的那几个（可热改）
    const on = st && Array.isArray(st.dshProfiles) ? st.dshProfiles : null;
    if (on && (!PROFILE || !on.includes(PROFILE))) return null;
    const mode = (st && st.default && st.default.mode) || "replace";
    if (mode === "off") return null;
    const body = readFileSync(ACTIVE, "utf8").trim();
    return body ? { mode, body } : null;
  } catch {
    return null;
  }
}
function put(asm, c) {
  if (!asm || typeof asm !== "object") return asm;
  const sections = Array.isArray(asm.sections) ? asm.sections : [];
  if (c.mode === "append") return { ...asm, sections: [...sections, { name: NAME, text: c.body }] };
  return { ...asm, sections: [{ name: NAME, text: c.body }] };
}
export default {
  name: NAME,
  inject: ["systemPrompt"],
  apply(ctx) {
    log("apply", "inject=" + JSON.stringify(["systemPrompt"]));
    // 宿主每轮 assemble 走 system-prompt/assemble 瀑布。必须 global：agent 作用域的
    // systemPrompt 是另一个实例，且切预设时宿主会整只换代理，实例上的 monkey-patch 会丢。
    const handler = async (assembly, _context, next) => {
      let assembled = assembly;
      if (typeof next === "function") {
        try {
          assembled = await next();
        } catch {
          assembled = assembly; // 下游抛错也要让上游兜底，不能把整轮发消息弄死
        }
      }
      const c = cfg();
      const out = c ? put(assembled, c) : assembled;
      log("assemble", (c ? "mode=" + c.mode : "off")
        + " in=" + (Array.isArray(assembled && assembled.sections) ? assembled.sections.length : -1)
        + " out=" + (Array.isArray(out && out.sections) ? out.sections.length : -1)
        + " names=" + (Array.isArray(out && out.sections) ? out.sections.map((s) => s && s.name).join(",") : "-"));
      return out;
    };
    try {
      ctx.on("system-prompt/assemble", handler, { global: true, prepend: true });
      log("hook", "system-prompt/assemble global");
    } catch (e) {
      // 老版本没有这个瀑布：退回包 assemble（关闭时同 this、同参数、同返回类型）
      const prompt = ctx.systemPrompt;
      const orig = prompt.assemble;
      prompt.assemble = function (...rest) {
        const c = cfg();
        if (!c) return orig.apply(this, rest);
        const out = orig.apply(this, rest);
        if (out && typeof out.then === "function") return out.then((asm) => put(asm, c));
        return put(out, c);
      };
    }
  },
};
`;
}

/** 会话内热切插件：只注册 /purge，改 state.json，不产生模型消息、不碰系统提示词。 */
export function slashSource(root) {
	const state = join(root, "state.json").replace(/\\/g, "/");
	return `// 由 agent-purge 生成（/purge 命令）；删掉本目录 + patch 段即取消。
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
const STATE = ${JSON.stringify(state)};
const NAME = ${JSON.stringify(SLASH_RESIDENT)};
const LOG = STATE.replace(/state\.json$/, "dsh.log");
function log(ev, extra) {
  try {
    appendFileSync(LOG, new Date().toISOString() + " " + PROFILE + " " + ev + (extra ? " " + extra : "") + "\\n");
  } catch { /* 只读环境不抛 */ }
}
const PROFILE = (() => {
  try {
    const m = /[\\\\/]profiles[\\\\/]([^\\\\/]+)[\\\\/]/.exec(new URL(import.meta.url).pathname);
    return m ? decodeURIComponent(m[1]) : "";
  } catch {
    return "";
  }
})();
function readState() {
  try { return JSON.parse(readFileSync(STATE, "utf8")) || {}; } catch { return {}; }
}
function saveState(st) {
  writeFileSync(STATE, JSON.stringify(st, null, 2) + "\\n");
}
function apPatch(fn) {
  const st = readState();
  if (!st.armed || typeof st.armed !== "object") st.armed = {};
  if (!Array.isArray(st.armed.dsh)) st.armed.dsh = [];
  fn(st, st.armed.dsh);
  saveState(st);
}
function handleAp(raw) {
  const parts = String(raw || "").trim().split(/\\s+/).filter(Boolean);
  const cmd = (parts[0] || "status").toLowerCase();
  const arg = parts.slice(1).join(" ").trim();
  if (cmd === "off") {
    apPatch((st, a) => {
      if (a.includes("install")) {
        st.dshPrevArmed = a.slice();
        st.armed.dsh = a.filter((x) => x !== "install");
      }
    });
    return { kind: "success", text: "agent-purge 已关闭（dsh），下一句起不注入" };
  }
  if (cmd === "on") {
    apPatch((st, a) => {
      if (!a.includes("install")) a.push("install");
      delete st.dshPrevArmed;
    });
    return { kind: "success", text: "agent-purge 已开启（dsh），下一句起生效" };
  }
  if (cmd === "mode") {
    const m = arg.toLowerCase();
    if (m !== "strict" && m !== "replace" && m !== "append") {
      return { kind: "error", text: "用法：/purge mode strict|replace|append" };
    }
    apPatch((st) => { if (!st.default || typeof st.default !== "object") st.default = {}; st.default.mode = m; });
    return { kind: "success", text: "模式已切到 " + m };
  }
  if (cmd === "status" || cmd === "help") {
    const st = readState();
    const a = st.armed && Array.isArray(st.armed.dsh) ? st.armed.dsh : [];
    const mode = (st.default && st.default.mode) || "replace";
    return { kind: "success", text: "agent-purge / dsh：" + (a.includes("install") ? "开" : "关") + " · 模式 " + mode + " · 人设 " + (st.persona || "-") + "（可用：on | off | status | mode <strict|replace|append>）" };
  }
  return { kind: "error", text: "用法：/purge on | off | status | mode <strict|replace|append>" };
}
export default {
  name: NAME,
  apply(ctx) {
    log("apply", "slash-only");
    try {
      if (typeof ctx.inject === "function") {
        ctx.inject(["commands"], (c) => {
          const spec = {
            description: "agent-purge 人设注入：开关 / 模式",
            input: { hint: "on | off | status | mode <strict|replace|append>" },
            handler: ({ rawInput }) => handleAp(rawInput),
          };
          // 主名 /purge（和 pi 等其他 harness 统一），/ap 留作别名；
          // 与已有同名命令（如 dsh-purge）撞车时只跳过那一个
          for (const n of ["purge", "ap"]) {
            try {
              c.commands.register({ name: n, ...spec });
              log("command", "registered /" + n);
            } catch (e) {
              log("command", "skip /" + n + " " + (e && e.message));
            }
          }
        });
      } else {
        log("command", "no inject api");
      }
    } catch (e) {
      log("command", "err " + (e && e.message));
    }
  },
};
`;
}

/** 一次性插件：人设快照内嵌，进程结束就没。 */
export function sessionSource(personaText, mode) {
	const put =
		mode === "append"
			? `return { ...asm, sections: [...(Array.isArray(asm.sections) ? asm.sections : []), { name: NAME, text: PERSONA }] };`
			: `return { ...asm, sections: [{ name: NAME, text: PERSONA }] };`;
	return `// 由 agent-purge 生成（一次性，进程退出即删）。
const PERSONA = ${JSON.stringify(personaText.trim())};
const NAME = ${JSON.stringify(SESSION)};
export default {
  name: NAME,
  inject: ["systemPrompt"],
  apply(ctx) {
    const prompt = ctx.systemPrompt;
    const orig = prompt.assemble;
    // 同常驻插件：不包 async，保持宿主的返回类型
    prompt.assemble = function (...rest) {
      const out = orig.apply(this, rest);
      const put = (asm) => {
        if (!asm || typeof asm !== "object") return asm;
        ${put}
      };
      if (out && typeof out.then === "function") return out.then(put);
      return put(out);
    };
  },
};
`;
}

/** 装一个插件名到三个 profile，并在 patch 里挂上（同一段 marker 幂等）。 */
export function addPlugin(name, source) {
	const pkg = JSON.stringify({ name, version: "0.0.0", type: "module", main: "index.js", agentPurge: true }, null, 1);
	const [begin, end] = mark(name);
	const block = `\n${begin}\n- insert:\n    - id: ${name}\n      name: ${name}\n${end}\n`;
	const files = [];
	const touched = []; // { dir, patch, before }：中途抛错时按相反顺序回滚
	// 只装进 dsh 已经建好的 profile；一个都没有说明 dsh 还没跑过
	const targets = liveProfiles();
	if (targets.length === 0) throw new Error("找不到任何 dsh profile（~/.dsh/profiles/*/package.json）—— 先启动一次 dsh，让它把 profile 建好再来装");
	// 预检：同名目录要么不存在，要么是我们的（package.json 带 agentPurge 标记），否则不碰
	for (const p of targets) {
		const dir = pluginDir(p, name);
		const meta = join(dir, "package.json");
		if (existsSync(dir) && !isOurs(meta)) throw new Error(`${dir} 已存在且不是 agent-purge 装的，拒绝覆盖`);
	}
	try {
		for (const p of targets) {
			const dir = pluginDir(p, name);
			const patch = patchFile(p);
			const before = existsSync(patch) ? readFileSync(patch, "utf8") : null;
			// 先登记再动手：下面任何一步抛错，这一轮的产物都能被回滚
			touched.push({ dir, patch, before });
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "package.json"), pkg);
			writeFileSync(join(dir, "index.js"), source);
			files.push(dir);
			const old = before ?? "# agent-purge 新建的 patch 层\n";
			if (old.includes(begin)) continue;
			// `[]` 是合法空数组，后面接 `- insert:` 就是非法 YAML：整份换成我们的段
			// 不存在也算“空”：走 stash 分支才能把“原本没有这个文件”记下来，卸载后才不会留个空壳
			const empty = before === null || /^\s*(\[\s*\]\s*)?$/.test(old);
			const next = empty ? block.slice(1) : old + block;
			if (empty) {
				// 整份替换会把原文端掉：原文 + 我们写出的成品都存下，卸载时对得上才整份还原
				// （对不上 = 期间被人改过，那就只剔自己那段）
				writeFileSync(join(dir, ".patch.before"), JSON.stringify({ before, after: next }));
			}
			writeFileSync(patch, next);
		}
	} catch (e) {
		// 回滚：撤销本次已写的文件，宁可完全没装也不留半套
		for (const { dir, patch, before } of touched.reverse()) {
			rmSync(dir, { recursive: true, force: true });
			if (before === null) rmSync(patch, { force: true });
			else writeFileSync(patch, before);
		}
		throw e;
	}
	return { dirs: files, profiles: targets };
}

/** 只撤自己那一段：目录 + patch marker，别的配置原样。 */
export function removePlugin(name) {
	const [begin, end] = mark(name);
	// 删 install 写入的那一段：前导 \n 可有可无（整份替换的形态没有），尾随 \n 一并吃掉
	const re = new RegExp(`(?:^|\\n)${begin}[\\s\\S]*?${end}\\n?`, "g");
	for (const p of DSH_PROFILES) {
		const dir = pluginDir(p, name);
		const meta = join(dir, "package.json");
		// 只删自己装的；同名但不是我们的目录留着（可能被用户或其他包占了）
		const ours = isOurs(meta);
		const stashFile = join(dir, ".patch.before");
		// 当初整份替换过的：记录躲在插件目录里，先读出来，不然删目录就丢了
		let stash = null;
		if (ours && existsSync(stashFile)) {
			try {
				stash = JSON.parse(readFileSync(stashFile, "utf8"));
			} catch {
				stash = null;
			}
		}
		if (ours) rmSync(dir, { recursive: true, force: true });
		const patch = patchFile(p);
		if (!existsSync(patch)) continue;
		const text = readFileSync(patch, "utf8");
		// 我们整份写的、且此后没人动过 → 整份还原（原本没这个文件就删掉它）
		if (stash && text === stash.after) {
			if (stash.before === null) rmSync(patch, { force: true });
			else writeFileSync(patch, stash.before);
			continue;
		}
		if (text.includes(begin)) writeFileSync(patch, text.replace(re, ""));
	}
}

/** patch 里还挂着这个名字吗（status 用；不许在有其他 insert 时谎报干净）。 */
export function hasPlugin(name) {
	const [begin] = mark(name);
	const targets = liveProfiles();
	if (targets.length === 0) return false;
	return targets.every((p) => {
		const patch = patchFile(p);
		return existsSync(join(pluginDir(p, name), "index.js")) && existsSync(patch) && readFileSync(patch, "utf8").includes(begin);
	});
}
