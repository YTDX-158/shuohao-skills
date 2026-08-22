#!/usr/bin/env node
// novel-storyboard — deterministic helpers for the novel-storyboard skill (分镜).
// Zero dependencies on purpose: the skill must work in any directory
// without an npm install. Node 18+ (stdlib only).

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */
/*
 * AI 短剧的前提刻在骨子里，结构由此而来：
 *
 *   镜（shot）   ＝ 一次视频生成调用（一镜一视频），时长固定 1–6 秒，
 *                  各自认领剧本节拍、带结构化元数据、一条 Seedance 提示词
 *   段（segment）＝ 可选的组织分组（15 秒情绪弧线单元），段内镜累加 = 段时长
 *   分镜图       ＝ 每个镜一张关键帧：f1 = 该镜的分镜图（供视频生成当参考）
 *
 * 每镜一条 seedancePrompt（五段：风格声明 / 镜号行 / 视觉描述 / 台词 / 无字幕），
 * 由模型照 references/seedance-prompt.md 手写，质量门逐字对账——改秒数必须同步
 * 改镜号行，validate 一个字符都不许漂。
 */

export const DEFAULT_PARAMS = {
  maxSegmentSeconds: 15, // 段（情绪弧线分组）上限（秒）
  minShotSeconds: 1,     // 单个镜下限——反应镜/插入特写可 1 秒
  maxShotSeconds: 6,     // 单个镜上限——长台词拆不动给到 6s
  maxOnScreen: 3,        // 单个镜同框人数上限，超了必须带拆解说明
  tolerance: 0.15,       // 每集总时长对剧本目标的容差
  charsPerSecond: 5.5,   // 中文台词语速（字/秒），情绪系数联动
};

export function paramsOf(doc) {
  return { ...DEFAULT_PARAMS, ...(doc?.params ?? {}) };
}

/** 景别枚举：英文短语必须出现在该分镜的分镜图提示词里。 */
export const SHOT_SIZES = {
  'extreme-wide': { zh: '大远景', phrase: 'extreme wide shot' },
  wide: { zh: '全景', phrase: 'wide shot' },
  medium: { zh: '中景', phrase: 'medium shot' },
  close: { zh: '特写', phrase: 'close-up' },
  'extreme-close': { zh: '大特写', phrase: 'extreme close-up' },
};

/** 运镜枚举：Seedance 词表（简版）。中文词应写进该镜的视觉描述/提示词。 */
export const CAMERA_MOVES = {
  'Static': '固定',
  'Push In': '推',
  'Pull Out': '拉',
  'Zoom': '变焦',
  'Pan': '摇',
  'Truck': '移',
  'Tilt': '俯仰摇',
  'Pedestal': '升降',
  'Arc': '环绕',
  'Tracking': '跟拍',
  'POV': '主观视角',
  'Shake': '晃动',
  'Roll': '旋转',
};

const CJK = /[㐀-鿿぀-ヿ가-힯]/;
const r1 = (n) => Math.round(n * 10) / 10;

/* ------------------------------------------------------------------ */
/* 镜的切点时刻                                                          */
/* ------------------------------------------------------------------ */
/*
 * 镜（shot）＝ 一次视频生成调用。段内镜按时间顺序，切点时刻从秒数累计
 * 推导（0, s1, s1+s2, …），报告与 export 的起点时刻都用它。
 */

/** 段内切点时刻表：[0, s1, s1+s2, …]（不含结尾）。 */
export function cutStarts(cuts) {
  const starts = [];
  let t = 0;
  for (const c of cuts ?? []) {
    starts.push(r1(t));
    t += c?.seconds ?? 0;
  }
  return starts;
}

/* ------------------------------------------------------------------ */
/* 剧本节拍展开                                                          */
/* ------------------------------------------------------------------ */
/*
 * 与 novel-script 相同的计秒规则，这里刻意重新实现而不是跨目录
 * import——每个 skill 必须自包含、可以单独拷走。参数从 script.json
 * 的 params 里读，两边天然一致。
 */

const SCRIPT_DEFAULTS = { charsPerSecond: 5.5, actionSeconds: 2.5 };
const lineChars = (line) => String(line ?? '').replace(/\s+/g, '').length;

/** 把 script.json 展开成分镜要认领的节拍清单：ep → scenes → beats。 */
export function expandScript(script) {
  const p = { ...SCRIPT_DEFAULTS, ...(script?.params ?? {}) };
  const eps = new Map();
  for (const ep of script?.episodes ?? []) {
    const scenes = (ep?.scenes ?? []).map((sc, i) => ({
      sceneIndex: i + 1,
      sceneId: sc.sceneId,
      lighting: sc.lighting ?? '',
      characters: sc.characters ?? [],
      props: sc.props ?? [],
      beats: (sc.flow ?? []).map((b, j) => {
        const isLine = typeof b?.line === 'string';
        return {
          n: j + 1,
          kind: isLine ? 'line' : 'action',
          seconds: r1(isLine ? lineChars(b.line) / p.charsPerSecond : p.actionSeconds),
          speaker: isLine ? b.speaker : undefined,
          delivery: isLine ? (b.delivery ?? '') : undefined,
          text: isLine ? b.line : b.action,
        };
      }),
    }));
    eps.set(ep.ep, { ep: ep.ep, targetSeconds: ep.targetSeconds, scenes });
  }
  return eps;
}

export const segSeconds = (segment) => r1((segment?.shots ?? []).reduce((n, c) => n + (c?.seconds ?? 0), 0));

/* ------------------------------------------------------------------ */
/* 镜头配方卡库（可选挂载）                                               */
/* ------------------------------------------------------------------ */
/*
 * shot-recipes 是可选挂载的卡库：给了 --shots <卡片目录> 才有 shot-recipe
 * 这道门。两个 skill 必须各自独立、谁没有谁都能跑，所以这里刻意不
 * import shot-recipes.mjs，自己写一份受限 frontmatter 解析——与
 * expandScript 同一个先例（跨目录 import 会让 skill 拷不走）。
 *
 * 只取门要用的机器字段，正文一概不读；语法受限到只认 `key: 标量` 与
 * `key: [a, b, c]` 行内数组——受限就没有歧义，25 行足够。卡片格式的合法性
 * 由 shot-recipes 自己的 lint 负责，这边只管读得懂的部分。
 */

const RECIPE_FIELDS = new Set(['id', 'name', 'name_en', 'cuts', 'must_phrases', 'sizes', 'cameras']);
const unquote = (s) => String(s).replace(/^['"](.*)['"]$/, '$1').trim();

/** 受限 frontmatter 解析：只回机器字段，没有 id 就当不是卡片。 */
export function parseCardFields(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? ''));
  if (!m) return null;
  const card = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!kv || !RECIPE_FIELDS.has(kv[1])) continue;
    const v = kv[2].trim();
    if (v.startsWith('[')) {
      const inner = v.replace(/^\[/, '').replace(/\]$/, '').trim();
      card[kv[1]] = inner
        ? inner.split(',').map(unquote).filter((x) => x !== '').map((x) => (/^-?\d+$/.test(x) ? Number(x) : x))
        : [];
    } else {
      card[kv[1]] = unquote(v);
    }
  }
  return card.id ? card : null;
}

/** 读卡片目录 → Map<id, 机器字段>。只吃顶层 .md（en/ 是正文翻译，机器字段只有一份）。 */
export function loadRecipes(dir) {
  const root = resolve(dir);
  const cards = new Map();
  if (!existsSync(root)) return cards;
  for (const f of readdirSync(root).filter((x) => x.endsWith('.md')).sort()) {
    const card = parseCardFields(readFileSync(join(root, f), 'utf8'));
    if (card) cards.set(card.id, card);
  }
  return cards;
}

/*
 * 建议景别 / 运镜**刻意不设门**，只在报告里提示偏离，理由三条：
 *   1. 配方是语汇不是法条——同一张卡在竖屏与横屏、两人与三人、有台词
 *      与无台词的情况下，景别会合理偏移（卡库那边把它们存成集合而不是
 *      序列，就是从结构上杜绝升级成硬门）
 *   2. 可选挂载的东西一旦变严就没人挂——挂了反而被拦，下次就不挂了
 *   3. 仓库已有明文判例：误拦的门比没有门更糟，门的信用比数量重要
 */
/** 运镜归一化：旧 H3 词表 → Seedance 词表。配方卡是跨 skill 共享的，版本可能落后，偏离提示要兼容。 */
const CAM_NORM = {
  'Static Shot': 'Static', 'Tracking Shot': 'Tracking', 'Arc Shot': 'Arc',
  'Zoom In': 'Zoom', 'Zoom Out': 'Zoom', 'Pan Left': 'Pan', 'Pan Right': 'Pan',
  'Truck Left': 'Truck', 'Truck Right': 'Truck', 'Tilt Up': 'Tilt', 'Tilt Down': 'Tilt',
  'Pedestal Up': 'Pedestal', 'Pedestal Down': 'Pedestal',
  'Roll Clockwise': 'Roll', 'Roll Counterclockwise': 'Roll',
  'Shake Slightly': 'Shake', 'Shake Strongly': 'Shake',
};
const camNorm = (x) => CAM_NORM[x] ?? x;

export function recipeDrift(cut, card) {
  const sizes = Array.isArray(card?.sizes) ? card.sizes : [];
  const cameras = Array.isArray(card?.cameras) ? card.cameras.map(camNorm) : [];
  return {
    sizes: sizes.length && !sizes.includes(cut?.size) ? sizes : [],
    cameras: cameras.length && !cameras.includes(camNorm(cut?.camera)) ? cameras : [],
  };
}

/* ------------------------------------------------------------------ */
/* 门失败累积                                                           */
/* ------------------------------------------------------------------ */
/*
 * 每次 validate / checkup 的结果本来跑完就没了，于是「模型最常违反哪条规则」
 * 只能靠印象。这里把每次运行与每条失败追加到工作目录的 .gates.jsonl，
 * stats 子命令再读回来，回答三个问题：
 *   哪道门最常响   → 那条规则模型最常无视，措辞该改
 *   哪道门从没响过 → 可能是死门，或者规则已经被模型内化了
 *   失败详情长什么样 → 反复出现却没有门的那类问题，只能靠人看这些自由文本
 *
 * 刻意做成纯函数 + CLI 负责 IO：自测不落盘也能验。
 * 写不进去就静默跳过——日志是附加价值，不能让它挡住主流程。
 */

export const GATE_LOG = '.gates.jsonl';

/** 一次运行产生的日志行（对象数组，CLI 负责序列化落盘）。 */
export function gateLogEntries(gates, { doc = '', at = '' } = {}) {
  const list = Array.isArray(gates) ? gates : [];
  if (!list.length) return [];
  const failed = list.filter((g) => !g.ok);
  const rows = [{ kind: 'run', at, doc, gates: list.length, failed: failed.length }];
  for (const g of failed) {
    rows.push({ kind: 'fail', at, doc, gate: g.id, label: g.label, detail: g.detail ?? '' });
  }
  return rows;
}

/** 汇总日志行。allGates 给全量门 id，用来找出「从没响过」的那些。 */
export function summarizeGateLog(entries, allGates = []) {
  const rows = (Array.isArray(entries) ? entries : []).filter((e) => e && typeof e === 'object');
  const runs = rows.filter((e) => e.kind === 'run');
  const fails = rows.filter((e) => e.kind === 'fail');
  const byGate = new Map();
  for (const f of fails) {
    if (!byGate.has(f.gate)) byGate.set(f.gate, { gate: f.gate, label: f.label ?? f.gate, count: 0, samples: [] });
    const rec = byGate.get(f.gate);
    rec.count += 1;
    if (rec.samples.length < 3 && f.detail) rec.samples.push(f.detail);
  }
  const ranked = [...byGate.values()].sort((a, b) => b.count - a.count || a.gate.localeCompare(b.gate));
  const silent = allGates.filter((id) => !byGate.has(id));
  return {
    runs: runs.length,
    cleanRuns: runs.filter((r) => !r.failed).length,
    fails: fails.length,
    ranked,
    silent,
  };
}

/* ------------------------------------------------------------------ */
/* stats                                                               */
/* ------------------------------------------------------------------ */

/** 报告与质量门共用的确定性统计。script 是硬前提——分镜离开剧本没有意义。 */
export function computeStats(board, script) {
  const params = paramsOf(board);
  const expanded = expandScript(script);
  const episodes = [];
  const batches = new Map(); // sceneId|lighting → 生成批次
  const dialogue = [];       // 配音对齐单：段 × 分镜 × 说话人 × 台词

  for (const ep of board?.episodes ?? []) {
    const sEp = expanded.get(ep.ep);
    let total = 0;
    let cutCount = 0;
    let withLines = 0;
    for (const seg of ep?.segments ?? []) {
      const scene = sEp?.scenes?.[seg.sceneIndex - 1];
      const secs = segSeconds(seg);
      total += secs;
      let segHasLine = false;
      (seg?.shots ?? []).forEach((cut, ci) => {
        cutCount++;
        if (!scene) return;
        const [from, to] = cut.beats ?? [];
        for (const b of scene.beats.slice((from ?? 1) - 1, to ?? 0)) {
          if (b.kind !== 'line') continue;
          segHasLine = true;
          dialogue.push({ segment: seg.id, cut: ci + 1, ep: ep.ep, speaker: b.speaker, line: b.text, seconds: b.seconds });
        }
      });
      if (segHasLine) withLines++;
      if (scene) {
        const key = `${scene.sceneId}|${scene.lighting}`;
        if (!batches.has(key)) {
          batches.set(key, { sceneId: scene.sceneId, lighting: scene.lighting, segments: [], characters: new Set(), props: new Set() });
        }
        const batch = batches.get(key);
        batch.segments.push(seg.id);
        for (const cut of seg?.shots ?? []) {
          for (const c of cut.characters ?? []) batch.characters.add(c);
          for (const pr of cut.props ?? []) batch.props.add(pr);
        }
      }
    }
    episodes.push({
      ep: ep.ep,
      target: sEp?.targetSeconds ?? 0,
      segments: (ep?.segments ?? []).length,
      cuts: cutCount,
      totalSeconds: r1(total),
      avgCutSeconds: cutCount ? r1(total / cutCount) : 0,
      withLines,
    });
  }

  const totals = {
    segments: episodes.reduce((n, e) => n + e.segments, 0),
    cuts: episodes.reduce((n, e) => n + e.cuts, 0),
    seconds: r1(episodes.reduce((n, e) => n + e.totalSeconds, 0)),
    targetSeconds: episodes.reduce((n, e) => n + e.target, 0),
    withLines: episodes.reduce((n, e) => n + e.withLines, 0),
    avgCutSeconds: 0,
  };
  totals.avgCutSeconds = totals.cuts ? r1(totals.seconds / totals.cuts) : 0;

  return {
    params,
    episodes,
    totals,
    dialogue,
    batches: [...batches.values()].map((b) => ({
      sceneId: b.sceneId, lighting: b.lighting, segments: b.segments,
      characters: [...b.characters], props: [...b.props],
    })),
  };
}

/* ------------------------------------------------------------------ */
/* 质量门                                                               */
/* ------------------------------------------------------------------ */

/** @绑定 ↔ 资产库：扫出文本里 @X 的已知引用与未知引用（按资产名最长前缀匹配）。 */
export function checkAtRefs(text, assets) {
  const known = [];
  const unknown = [];
  const s = String(text ?? '');
  const list = [...assets];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '@') continue;
    let best = null;
    for (const a of list) {
      if (s.startsWith(a, i + 1) && (best === null || a.length > best.length)) best = a;
    }
    if (best) {
      known.push(best);
      i += best.length;
    } else {
      const m = /^[^\s，。；、,;()（）\[\]【】<>《》"']+/.exec(s.slice(i + 1));
      unknown.push(m ? m[0] : '@');
      i += m ? m[0].length : 0;
    }
  }
  return { known, unknown };
}

/** @绑定资产库：cast 角色名/别名 + art 道具名（设定图名字）。空 = 没给上游。 */
export function assetNames(ctx = {}) {
  const assets = new Set();
  for (const c of ctx.cast?.characters ?? []) {
    if (c?.name) assets.add(c.name);
    for (const a of c?.aliases ?? []) assets.add(a);
  }
  for (const pr of ctx.art?.props ?? []) if (pr?.name) assets.add(pr.name);
  return assets;
}

export function gateReport(board, ctx = {}) {
  const gates = [];
  const add = (id, label, ok, detail = '') => gates.push({ id, label, ok, detail });
  const params = paramsOf(board);
  const script = ctx.script ?? null;
  const expanded = script ? expandScript(script) : null;
  const eps = Array.isArray(board?.episodes) ? board.episodes : [];
  const bad = {
    coverage: [], segCap: [], shotLen: [], fit: [], duration: [], crowd: [],
    id: [], size: [], camera: [], english: [], names: [], refs: [],
    style: [], meta: [], bind: [], dlg: [], notext: [], shotDur: [], recipe: [],
  };
  // 配方卡库是可选挂载：ctx.recipes 为空就整门跳过（不是「没有 cut 带 recipe」就跳过）
  const recipes = ctx.recipes ?? null;
  let recipeRefs = 0;
  // 全片视觉风格声明：自由文本（如「写实向半厚涂」「真人电影风格」），
  // 出现在每镜 seedancePrompt 头部，同剧画风不许漂。缺了直接拦——没有 style 就没有头部声明
  const style = String(board?.style ?? '').trim();
  if (!style) bad.style.push('缺顶层 style（全片视觉风格声明，如「写实向半厚涂」）');

  // 提示词禁人名：outline 的名字 + cast 的名字与别名
  const banned = [];
  for (const c of ctx.outline?.characters ?? []) if (c?.name) banned.push(c.name);
  for (const c of ctx.cast?.characters ?? []) {
    if (c?.name) banned.push(c.name);
    for (const a of c?.aliases ?? []) banned.push(a);
  }

  // @绑定资产库：cast 角色名/别名 + art 道具名（设定图名字）。空 = 没给上游，bind 门跳过
  const assets = assetNames(ctx);

  for (const ep of eps) {
    const label = `E${String(ep?.ep).padStart(2, '0')}`;
    const sEp = expanded?.get(ep?.ep);
    if (expanded && !sEp) bad.refs.push(`${label} 在剧本里不存在`);

    // 段号纪律：格式、集号一致、连号
    (ep?.segments ?? []).forEach((seg, i) => {
      const want = `${label}-${String(i + 1).padStart(2, '0')}`;
      if (seg?.id !== want) bad.id.push(`第 ${i + 1} 段应为 ${want}，实际「${seg?.id}」`);
    });

    let prevSceneIndex = 0;
    for (const seg of ep?.segments ?? []) {
      const sid = seg?.id ?? '?';
      const cuts = seg?.shots ?? [];
      const total = segSeconds(seg);

      if (!(total > 0) || total > params.maxSegmentSeconds) {
        bad.segCap.push(`${sid} 共 ${total} 秒`);
      }

      const scene = sEp ? sEp.scenes[seg?.sceneIndex - 1] : null;
      if (sEp && !scene) bad.refs.push(`${sid} 的 sceneIndex ${seg?.sceneIndex} 在剧本第 ${ep.ep} 集里不存在`);
      if (scene) {
        if (seg.sceneIndex < prevSceneIndex) bad.coverage.push(`${sid} 场次顺序倒退`);
        prevSceneIndex = Math.max(prevSceneIndex, seg.sceneIndex);
      }

      cuts.forEach((cut, ci) => {
        const cid = `${sid}#${ci + 1}`;

        if (!(cut?.seconds >= params.minShotSeconds) || cut.seconds > params.maxShotSeconds) {
          bad.shotLen.push(`${cid} ${cut?.seconds ?? '?'} 秒`);
        }
        if ((cut?.characters ?? []).length > params.maxOnScreen && !String(cut?.note ?? seg?.note ?? '').trim()) {
          bad.crowd.push(`${cid} 同框 ${cut.characters.length} 人且没有拆解说明`);
        }
        if (!SHOT_SIZES[cut?.size]) {
          bad.size.push(`${cid} 景别「${cut?.size}」不在枚举里`);
        } else if (!String(cut?.frame ?? '').toLowerCase().includes(SHOT_SIZES[cut.size].phrase)) {
          bad.size.push(`${cid} 分镜图提示词缺景别短语「${SHOT_SIZES[cut.size].phrase}」`);
        }
        // 运镜：Seedance 词表 + 运镜词落在自己的视觉描述/提示词里（中英任一即可）
        if (!CAMERA_MOVES[cut?.camera]) {
          bad.camera.push(`${cid} 运镜「${cut?.camera}」不在 Seedance 词表里`);
        } else {
          const zh = String(CAMERA_MOVES[cut.camera]).toLowerCase();
          const en = String(cut.camera).toLowerCase();
          const desc = String(cut?.shotDesc ?? '').toLowerCase();
          const prompt = String(cut?.seedancePrompt ?? '').toLowerCase();
          if (!(desc.includes(zh) || desc.includes(en) || prompt.includes(zh) || prompt.includes(en))) {
            bad.camera.push(`${cid} 视觉描述/提示词里缺运镜词「${zh}」`);
          }
        }
        const frame = String(cut?.frame ?? '');
        if (!frame.trim()) bad.english.push(`${cid} 的分镜图提示词为空`);
        if (CJK.test(frame)) bad.english.push(`${cid} 的分镜图提示词混入了非英文`);
        for (const name of banned) {
          if (frame.includes(name)) bad.names.push(`${cid} 的分镜图提示词出现角色名「${name}」`);
        }

        // 结构化元数据四件套：空间/姿态/位置/情绪全要，缺一不得
        for (const k of ['space', 'pose', 'position', 'mood']) {
          if (!String(cut?.[k] ?? '').trim()) bad.meta.push(`${cid} 缺 ${k}（元数据四件套之一）`);
        }

        // seedancePrompt：五段结构逐字对账（每镜一条，照 references/seedance-prompt.md）
        const sp = String(cut?.seedancePrompt ?? '');
        if (!sp.trim()) {
          bad.notext.push(`${cid} 缺 seedancePrompt（每镜一条，写法见 references/seedance-prompt.md）`);
        } else {
          // 头部：风格声明 + 画面无文字 + 无BGM
          if (style && !sp.includes(style)) bad.style.push(`${cid} 提示词头部缺全片风格声明「${style}」`);
          if (!sp.includes('画面不要出现任何文字') || !sp.includes('生成视频无BGM')) {
            bad.style.push(`${cid} 提示词头部缺「画面不要出现任何文字 / 生成视频无BGM」`);
          }
          // 镜号行：c<镜号>,<秒>s —— 秒数必须 = seconds 字段，一个字符都不许漂
          const mark = `c${String(ci + 1).padStart(2, '0')},${cut.seconds}s`;
          if (!sp.includes(mark)) bad.shotDur.push(`${cid} 提示词缺镜号行「${mark}」——秒数必须与 seconds 字段一致`);
          // 无字幕约束（尾部强调，双保险）
          if (!sp.includes('不出现任何文字')) bad.notext.push(`${cid} 提示词缺无字幕约束「不出现任何文字」`);
          // @绑定 ↔ 资产库：从元数据 + 视觉描述 + 提示词里提取
          if (assets.size) {
            const all = [cut.pose, cut.position, cut.mood, cut.shotDesc, sp].join('\n');
            for (const u of checkAtRefs(all, assets).unknown) bad.bind.push(`${cid} @「${u.slice(0, 10)}」不在资产库里（角色/道具设定图名字）`);
          }
        }

        // 镜头配方：id 在卡库里 + 每条必备短语进了本切的 frame
        // 判定与 shot-recipes 的 checkRecipes 完全一致：两边小写化后 includes，逐条全中才算过
        if (recipes && typeof cut?.recipe === 'string' && cut.recipe) {
          recipeRefs += 1;
          const card = recipes.get(cut.recipe);
          if (!card) {
            bad.recipe.push(`${cid} 引用的配方「${cut.recipe}」不在配方库里`);
          } else {
            const lower = frame.toLowerCase();
            for (const ph of card.must_phrases ?? []) {
              if (!lower.includes(String(ph).toLowerCase())) {
                bad.recipe.push(`${cid} 的分镜图提示词缺配方「${card.name}」的必备短语「${ph}」`);
              }
            }
          }
        }

        // 引用对账 + 台词装得下 + 台词逐字进 seedancePrompt
        if (scene) {
          const cast = new Set(scene.characters);
          for (const c of cut?.characters ?? []) {
            if (!cast.has(c)) bad.refs.push(`${cid} 的 ${c} 不在剧本该场人物里`);
          }
          const propSet = new Set(scene.props);
          for (const pr of cut?.props ?? []) {
            if (!propSet.has(pr)) bad.refs.push(`${cid} 的 ${pr} 不在剧本该场道具里`);
          }
          const [from, to] = cut?.beats ?? [];
          if (Number.isInteger(from) && Number.isInteger(to) && from >= 1 && to <= scene.beats.length && from <= to) {
            let dlg = 0;
            for (const b of scene.beats.slice(from - 1, to)) {
              if (b.kind !== 'line') continue;
              dlg += b.seconds;
              if (sp && !sp.includes(b.text)) {
                bad.dlg.push(`${sid} 的提示词缺台词「${b.text.slice(0, 12)}…」——台词按剧本原始语言逐字`);
              }
            }
            if (dlg > cut.seconds) bad.fit.push(`${cid} 台词 ${r1(dlg)} 秒装不进 ${cut.seconds} 秒`);
          }
        }
      });

      // 多格配方靠「连续同 id 的 run」表达（不引入新结构）：卡片 cuts 下限 ≥ 2 时，
      // 连续段的长度不得小于该下限——单独挂一格的两格配方是没兑现的配方
      if (recipes) {
        for (let i = 0; i < cuts.length; ) {
          const rid = cuts[i]?.recipe;
          if (typeof rid !== 'string' || !rid) {
            i += 1;
            continue;
          }
          let j = i;
          while (j + 1 < cuts.length && cuts[j + 1]?.recipe === rid) j += 1;
          const card = recipes.get(rid);
          const min = Array.isArray(card?.cuts) ? card.cuts[0] : 0;
          const run = j - i + 1;
          if (min >= 2 && run < min) {
            bad.recipe.push(`${sid}#${i + 1} 的配方「${card.name}」要 ${min} 格连排，这里只有 ${run} 格——多格配方靠连续同 recipe 的分镜表达`);
          }
          i = j + 1;
        }
      }
    }

    // 节拍全覆盖：每场的节拍被恰好一次、按顺序、连续认领（分镜级）
    if (sEp) {
      for (const scene of sEp.scenes) {
        const claims = [];
        for (const seg of ep?.segments ?? []) {
          if (seg?.sceneIndex !== scene.sceneIndex) continue;
          (seg?.shots ?? []).forEach((cut, ci) => {
            const [from, to] = cut?.beats ?? [];
            if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > scene.beats.length || from > to) {
              bad.coverage.push(`${seg.id}#${ci + 1} 的节拍区间 [${from}, ${to}] 不合法（该场共 ${scene.beats.length} 拍）`);
              return;
            }
            claims.push([from, to, `${seg.id}#${ci + 1}`]);
          });
        }
        let cursor = 1;
        for (const [from, to, id] of claims) {
          if (from !== cursor) {
            bad.coverage.push(`${label} 第 ${scene.sceneIndex} 场第 ${cursor} 拍${from > cursor ? '没人认领' : `被 ${id} 重复认领`}`);
          }
          cursor = Math.max(cursor, to + 1);
        }
        if (claims.length && cursor <= scene.beats.length) {
          bad.coverage.push(`${label} 第 ${scene.sceneIndex} 场第 ${cursor}–${scene.beats.length} 拍没人认领`);
        }
        if (!claims.length && scene.beats.length) {
          bad.coverage.push(`${label} 第 ${scene.sceneIndex} 场整场没有分镜`);
        }
      }

      // 每集总时长对齐剧本目标
      if (sEp.targetSeconds > 0) {
        const total = (ep?.segments ?? []).reduce((n, s) => n + segSeconds(s), 0);
        const lo = sEp.targetSeconds * (1 - params.tolerance);
        const hi = sEp.targetSeconds * (1 + params.tolerance);
        if (total < lo) bad.duration.push(`${label} 欠 ${r1(lo - total)} 秒（${r1(total)}s / 目标 ${sEp.targetSeconds}s）`);
        if (total > hi) bad.duration.push(`${label} 超 ${r1(total - hi)} 秒（${r1(total)}s / 目标 ${sEp.targetSeconds}s）`);
      }
    }
  }

  const SKIP_SCRIPT = '未提供 script.json，本门跳过（视为通过）';
  const SKIP_NAMES = '未提供 outline/cast，本门跳过（视为通过）';
  const SKIP_BIND = '未提供 cast/art（@绑定资产库），本门跳过（视为通过）';
  const SKIP_SHOTS = '未挂载配方卡库（--shots <卡片目录>），本门跳过（视为通过）';
  const NO_RECIPE = '本批分镜没有引用配方';

  add('coverage', '剧本节拍被恰好一次、按顺序、连续认领（镜级）', bad.coverage.length === 0, script ? bad.coverage.join('；') : SKIP_SCRIPT);
  add('segment-cap', `每段 0 < 总秒数 ≤ ${params.maxSegmentSeconds}（情绪弧线单元的上限）`, eps.length > 0 && bad.segCap.length === 0, bad.segCap.join('；'));
  add('cut-length', `每个镜 ${params.minShotSeconds}–${params.maxShotSeconds} 秒——短剧的注意力节奏`, eps.length > 0 && bad.shotLen.length === 0, bad.shotLen.join('；'));
  add('dialogue-fit', '认领节拍的台词装得进镜秒数', bad.fit.length === 0, script ? bad.fit.join('；') : SKIP_SCRIPT);
  add('ep-duration', `每集总时长在剧本目标 ±${Math.round(params.tolerance * 100)}% 内`, bad.duration.length === 0, script ? bad.duration.join('；') : SKIP_SCRIPT);
  add('crowd', `单个镜同框 ≤ ${params.maxOnScreen} 人，超了必须带拆解说明`, bad.crowd.length === 0, bad.crowd.join('；'));
  add('segment-id', '段号 E01-01 格式、按顺序连号', bad.id.length === 0, bad.id.join('；'));
  add('size-phrase', '景别短语写进分镜图提示词', bad.size.length === 0, bad.size.join('；'));
  add('camera-phrase', '运镜用 Seedance 词表，且运镜词落在自己的视觉描述/提示词里', bad.camera.length === 0, bad.camera.join('；'));
  add('shot-duration', '镜号行 c<镜号>,<秒>s 的秒数 = seconds 字段（每镜固定时长）', eps.length > 0 && bad.shotDur.length === 0, bad.shotDur.join('；'));
  add('dialogue-lang', '认领节拍的台词逐字进 seedancePrompt（按剧本原始语言，不改写）', bad.dlg.length === 0, script ? bad.dlg.join('；') : SKIP_SCRIPT);
  add('notext', '每镜提示词带无字幕约束（画面无文字/不出现任何文字字幕）', bad.notext.length === 0, bad.notext.join('；'));
  add('style-phrase', `每镜提示词头部风格声明统一（${style || '缺 style'} + 画面无文字 + 无BGM）——同剧画风不许漂`, bad.style.length === 0, bad.style.join('；'));
  add('prompt-english', '分镜图提示词全英文且非空', bad.english.length === 0, bad.english.join('；'));
  add('prompt-no-names', '分镜图提示词不含角色名', bad.names.length === 0, banned.length ? bad.names.join('；') : SKIP_NAMES);
  add('bind', '@绑定全部 ∈ 资产库（角色/道具设定图名字）', bad.bind.length === 0, assets.size ? bad.bind.join('；') : SKIP_BIND);
  add('refs', '场次／人物／道具对账剧本', bad.refs.length === 0, script ? bad.refs.join('；') : SKIP_SCRIPT);
  // 可选挂载的门放最后：没给 --shots 就跳过；给了但全篇没引用配方也算通过，但要明说，不静默
  add(
    'shot-recipe',
    '引用的配方存在、必备短语进了分镜图提示词、多格配方连排够格数',
    bad.recipe.length === 0,
    recipes ? (bad.recipe.length ? bad.recipe.join('；') : recipeRefs ? '' : NO_RECIPE) : SKIP_SHOTS,
  );

  return gates;
}

/* ------------------------------------------------------------------ */
/* validate                                                            */
/* ------------------------------------------------------------------ */

export function validateStoryboard(board, ctx = {}) {
  const problems = [];
  const p = (msg) => problems.push(msg);
  if (!board || typeof board !== 'object') return ['storyboard.json 不是对象'];

  if (!String(board.source ?? '').trim()) p('缺少 source（剧名）');
  if (!String(board.style ?? '').trim()) p('缺少 style（全片视觉风格声明，如「写实向半厚涂」）');
  const eps = board.episodes;
  if (!Array.isArray(eps) || eps.length === 0) {
    p('episodes 为空');
    return problems;
  }
  const seen = new Set();
  for (const ep of eps) {
    const label = `第 ${ep?.ep ?? '?'} 集`;
    if (!Number.isInteger(ep?.ep) || ep.ep < 1) p(`${label}的 ep 必须是正整数`);
    if (seen.has(ep?.ep)) p(`集号 ${ep.ep} 重复`);
    seen.add(ep?.ep);
    if (!Array.isArray(ep?.segments) || ep.segments.length === 0) {
      p(`${label}没有段`);
      continue;
    }
    for (const seg of ep.segments) {
      const sid = seg?.id ?? '?';
      if (typeof seg?.id !== 'string') p(`${label}有段缺 id`);
      if (!Number.isInteger(seg?.sceneIndex) || seg.sceneIndex < 1) p(`${sid} 缺 sceneIndex（剧本里第几场）`);
      if (!Array.isArray(seg?.shots) || seg.shots.length === 0) {
        p(`${sid} 没有分镜`);
        continue;
      }
      seg.shots.forEach((cut, ci) => {
        const cid = `${sid}#${ci + 1}`;
        if (!Array.isArray(cut?.beats) || cut.beats.length !== 2) p(`${cid} 的 beats 必须是 [起, 止] 两个数`);
        if (typeof cut?.seconds !== 'number') p(`${cid} 缺 seconds（镜时长，1–6 秒）`);
        if (!Array.isArray(cut?.characters)) p(`${cid} 缺 characters（空镜给空数组）`);
        if (typeof cut?.frame !== 'string') p(`${cid} 缺 frame（分镜图英文提示词）`);
        if (!String(cut?.space ?? '').trim()) p(`${cid} 缺 space（元数据：空间）`);
        if (!String(cut?.pose ?? '').trim()) p(`${cid} 缺 pose（元数据：姿态，@角色-姿态）`);
        if (!String(cut?.position ?? '').trim()) p(`${cid} 缺 position（元数据：位置，含面朝@谁）`);
        if (!String(cut?.mood ?? '').trim()) p(`${cid} 缺 mood（元数据：情绪，只写本镜主角）`);
        if (typeof cut?.shotDesc !== 'string') p(`${cid} 缺 shotDesc（视频视觉描述）`);
        if (typeof cut?.seedancePrompt !== 'string') p(`${cid} 缺 seedancePrompt（每镜一条 Seedance 提示词，写法见 references/seedance-prompt.md）`);
      });
    }
  }

  for (const g of gateReport(board, ctx)) {
    if (!g.ok) p(`质量门未过：${g.label}${g.detail ? `（${g.detail}）` : ''}`);
  }
  return problems;
}

/* ------------------------------------------------------------------ */
/* seed — 从 script.json 确定性预填                                      */
/* ------------------------------------------------------------------ */

export function seedFromScript(script, epRange = null) {
  const expanded = expandScript(script);
  const inRange = (n) => !epRange || (n >= epRange[0] && n <= epRange[1]);
  const episodes = [];
  for (const [epNo, sEp] of expanded) {
    if (!inRange(epNo)) continue;
    episodes.push({
      ep: epNo,
      segments: [],
      seedScenes: sEp.scenes.map((sc) => ({
        sceneIndex: sc.sceneIndex,
        sceneId: sc.sceneId,
        lighting: sc.lighting,
        characters: sc.characters,
        props: sc.props,
        beats: sc.beats.map((b) => ({
          n: b.n,
          kind: b.kind,
          seconds: b.seconds,
          ...(b.speaker ? { speaker: b.speaker } : {}),
          text: b.text,
        })),
      })),
    });
  }
  return { source: script?.source ?? '', episodes };
}

/* ------------------------------------------------------------------ */
/* export — Seedance 投产包                                             */
/* ------------------------------------------------------------------ */
/*
 * 固定投产结构：每段一个文件夹——E01-01/f1.png … fN.png + prompt-NN.md
 * （每镜一条 seedancePrompt，与 fN.png 一一对应），根部一份 manifest：
 * 逐镜列出提示词路径、秒数、切点、参考图（sceneImage + @绑定设定图）与缺图标注。
 * 提示词就躺在图旁边，整个文件夹拖给 Seedance 就是逐镜生成。
 * 纯函数返回文件清单，落盘在 CLI 层——可测性。
 */
export function exportPack(board, script, { imageExists = () => false, dir = '.', assets = new Set() } = {}) {
  const prefix = dir === '.' ? '' : `${dir}/`;
  const files = [];
  const manifest = [];
  let missingTotal = 0;
  for (const ep of board?.episodes ?? []) {
    for (const seg of ep?.segments ?? []) {
      const starts = cutStarts(seg.shots);
      (seg.shots ?? []).forEach((cut, i) => {
        const no = String(i + 1).padStart(2, '0');
        const sp = String(cut?.seedancePrompt ?? '').trim();
        // 参考图清单：场景图 + @绑定（角色/道具设定图名字）
        const all = [cut.pose, cut.position, cut.mood, cut.shotDesc, sp].join('\n');
        const binds = [...new Set(checkAtRefs(all, assets).known)];
        const refs = [cut.sceneImage, ...binds].filter(Boolean);
        const promptMd = `# ${seg.id} · c${no} · ${cut.seconds}s 镜\n\n参考图（生成时挂载）：\n${
          refs.length ? refs.map((r) => `- \`${r}\``).join('\n') : '- （无）'
        }\n\n---\n\n${sp}\n`;
        files.push({ path: `${prefix}${seg.id}/prompt-${no}.md`, content: promptMd });
        const picture = `${prefix}${seg.id}/f${i + 1}.png`;
        const missing = imageExists(picture) ? [] : [picture];
        missingTotal += missing.length;
        manifest.push({
          segment: seg.id,
          shot: i + 1,
          seconds: cut.seconds,
          start: starts[i],
          prompt: `${prefix}${seg.id}/prompt-${no}.md`,
          picture,
          sceneImage: cut.sceneImage ?? null,
          binds,
          missing,
        });
      });
    }
  }
  files.push({ path: `${prefix}manifest.json`, content: JSON.stringify(manifest, null, 2) + '\n' });
  return { files, manifest, missingTotal };
}

/* ------------------------------------------------------------------ */
/* slug                                                                */
/* ------------------------------------------------------------------ */

export function slug(name) {
  const cleaned = String(name)
    .trim()
    .replace(/[\s/\\:*?"<>|·]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'storyboard';
}

/* ------------------------------------------------------------------ */
/* render — 界面文案                                                    */
/* ------------------------------------------------------------------ */

/*
 * 界面文案表：内置 zh / en 两套。语言优先级 --lang > JSON 顶层 lang 字段 > 'zh'，
 * 经 ctx.lang 传给渲染器。只管报告界面标签——与 seedancePrompt 的内容
 * 互相独立：界面切英文不改提示词。
 * 数据（seedancePrompt、画面摘要、台词、质量门 detail）不在此表，原样透传。
 */
/* 门标签与「跳过」提示的英文映射：质量门面板是报告的一部分，出英文报告时
 * 这里做展示层翻译——gateReport 的逻辑与中文诊断文案一行不动（CLI 仍是中文）。
 * 动态阈值由门自己算，映射里只写固定语义；未命中的 id 回落到原标签。 */
const GATE_LABELS_EN = {
  'coverage': 'Every script beat claimed exactly once, in order, contiguous (shot level)',
  'segment-cap': 'Each segment 0 < total ≤ {1}s (the emotional-arc cap)',
  'cut-length': 'Every shot {0}–{1}s — the short-drama attention rhythm',
  'dialogue-fit': 'Dialogue of the claimed beats fits within the shot duration',
  'ep-duration': 'Episode total within ±{0}% of the script\'s target',
  'crowd': 'At most {0} characters on screen per shot; more requires a breakdown note',
  'segment-id': 'Segment IDs in E01-01 format, sequential',
  'size-phrase': 'Shot-size phrase present in the frame prompt',
  'camera-phrase': 'Camera move from the Seedance vocabulary, present in its own visual description / prompt',
  'shot-duration': 'Shot header c<no>,<sec>s matches the seconds field (fixed per-shot duration)',
  'dialogue-lang': 'Claimed dialogue appears verbatim in seedancePrompt (original script language)',
  'notext': 'Every shot prompt carries the no-text constraint',
  'style-phrase': 'Shot prompt header style declaration consistent — one drama, one look',
  'prompt-english': 'Frame prompts are English and non-empty',
  'prompt-no-names': 'Frame prompts carry no character names',
  'bind': 'Every @binding is an asset (character / prop sheet name)',
  'refs': 'Scenes / characters / props audited against the script',
  'shot-recipe': 'Referenced recipes exist, their must-phrases are in the frame prompt, multi-shot recipes run long enough',
};
const GATE_SKIPS_EN = {
    '未提供 outline.json，本门跳过（视为通过）': 'outline.json not provided — gate skipped (treated as passing)',
    '未提供 art.json，本门跳过（视为通过）': 'art.json not provided — gate skipped (treated as passing)',
    '未提供 script.json，本门跳过（视为通过）': 'script.json not provided — gate skipped (treated as passing)',
    '未提供 outline/cast，本门跳过（视为通过）': 'outline/cast not provided — gate skipped (treated as passing)',
    '未提供 cast.json，本门跳过（视为通过）': 'cast.json not provided — gate skipped (treated as passing)',
    '未提供 cast/art（@绑定资产库），本门跳过（视为通过）': 'cast/art not provided (@binding asset library) — gate skipped (treated as passing)',
    '未挂载配方卡库（--shots <卡片目录>），本门跳过（视为通过）': 'no recipe card library mounted (--shots <cards dir>) — gate skipped (treated as passing)',
    '本批分镜没有引用配方': 'no shot in this batch references a recipe',
};
/** 报告里的门文案：英文界面取映射，未命中或中文界面回落原文。 */
const gateText = (g, lang) => {
  if (lang !== 'en') return { label: g.label, detail: g.detail };
  const en = GATE_LABELS_EN[g.id];
  // 阈值仍由门自己算：把中文标签里出现的数字按序填进 {0} {1}
  const nums = String(g.label).match(/\d+(?:\.\d+)?/g) ?? [];
  const label = en ? en.replace(/\{(\d)\}/g, (m, i) => nums[Number(i)] ?? m) : g.label;
  return { label, detail: GATE_SKIPS_EN[g.detail] ?? g.detail };
};

const I18N = {
  zh: {
    langCode: 'zh',
    kicker: '分镜',
    docTitle: (s, a, b) => `${s} · 分镜${a === b ? `（第 ${a} 集）` : `（第 ${a}–${b} 集）`}`,
    epRange: (a, b) => (a === b ? `第 ${a} 集` : `第 ${a}–${b} 集`),
    exportJson: '导出 JSON',
    gatesPass: '全部通过',
    gatesFail: (n) => `${n} 项未过`,
    gatePill: (okN, total) => `质量门 ${okN} / ${total}`,
    kpi: {
      segments: '生成段', segmentsSub: (cap) => `段 = 情绪弧线分组，上限 ${cap} 秒`,
      cuts: '镜', cutsSub: (avg) => `平均 ${avg} 秒一镜（一镜一视频）`,
      time: '预估总时长', timeSub: (t) => `目标 ${t}`,
      batches: '生成批次', batchesSub: '同场景同光照共用环境参考图',
      lines: '台词段', linesSub: '其余是纯画面段',
    },
    secRhythm: '镜头节奏带',
    secSegments: '分集分镜表',
    secBatches: '生成批次单',
    secDialogue: '配音对齐单',
    secGates: '质量门',
    rhythmNote: '粗分隔 = 段边界 · 片宽 = 镜时长占比 · 颜色越深景别越近',
    segmentsNote: '段 = 情绪弧线分组 · 每镜一图一提示词（seedancePrompt），一镜一视频',
    batchesNote: '自动汇总 · 同批段共用同一张环境参考图',
    dialogueNote: '自动汇总 · TTS 音频对到哪一段的第几镜',
    epHead: (nSeg, nCut, total, target) => `${nSeg} 段 ${nCut} 镜 · 共 ${total} 秒 / 目标 ${target} 秒`,
    segHead: (total, n) => `${total} 秒 · ${n} 个镜`,
    secBadge: (secs, n) => `${secs}s · ${n} 镜`,
    rhythmVal: (nSeg, nCut, secs) => `${nSeg} 段 ${nCut} 镜 · ${secs}s`,
    beatsLabel: (s, from, to) => `第 ${s} 场 ${from === to ? `第 ${from} 拍` : `第 ${from}–${to} 拍`}`,
    masterLabel: '主分镜图',
    subLabel: (i) => `子分镜 ${i}`,
    frameMissing: (i) => `#${i} 未生成`,
    framePrompt: '分镜图提示词',
    seedancePrompt: 'Seedance 提示词',
    promptSection: 'Seedance 提示词（每镜一条）',
    showSegs: '▾ 展开全部段',
    hideSegs: '▴ 收起',
    copy: '复制', copied: '已复制', copyFailed: '复制失败',
    dialogueCols: ['段 · 镜', '说话人', '台词', '台词秒数'],
    cutCols: ['镜', '起点', '秒', '景别', '运镜', '元数据', '配方', '画面', '人物'],
    batchCols: ['场景', '光照', '段', '需要的角色', '道具'],
    atSec: (t) => `${t.toFixed(2)}s 起`,
    batchLabel: (num) => `批次 ${num}`,
    batchNeed: (chars, props) => `需要：${chars.length ? chars.join('、') + ' 的角色设定图' : '无角色（空镜）'}${props.length ? ' · ' + props.join('、') : ''}`,
    voiceOver: '画外音',
    listSep: '、',
    sizeName: (size) => SHOT_SIZES[size]?.zh ?? size,
    cameraLabel: (camera) => `${camera}（${CAMERA_MOVES[camera] ?? '?'}）`,
    recipeNone: '—',
    recipeName: (card, id) => card?.name ?? id,
    recipeDrift: (sizes, cameras) =>
      `配方建议${[sizes.length ? `景别 ${sizes.join(' / ')}` : '', cameras.length ? `运镜 ${cameras.join(' / ')}` : ''].filter(Boolean).join(' · ')}——只提示不设门`,
    recipeHint: (n) => `ℹ️ ${n} 处分镜的景别／运镜偏离了配方建议——配方是语汇不是法条，只提示不设门（报告的「配方」列有 ≠ 标记）`,
    speakerLine: (name, text) => `${name}：「${text}」`,
    withLighting: (name, lighting) => (lighting ? `${name}（${lighting}）` : name),
    fmtMin: (sec) => `${Math.floor(sec / 60)} 分 ${Math.round(sec % 60)} 秒`,
    unitSeg: '段',
    unitCut: '镜',
    colophon: '分镜由模型依据剧本切分：段 = 情绪弧线分组（≤15 秒），镜 = 一次视频生成（一镜一视频，1–6 秒），每镜一条 Seedance 提示词 + 一张关键帧图。镜号行秒数、元数据四件套、@绑定、台词逐字、无字幕约束全部由脚本确定性对账。分镜图出图走 codex/Seedream，环境与角色设定图当参考图。',
  },
  en: {
    langCode: 'en',
    kicker: 'Storyboard',
    docTitle: (s, a, b) => `${s} · Storyboard (${a === b ? `Episode ${a}` : `Episodes ${a}–${b}`})`,
    epRange: (a, b) => (a === b ? `Episode ${a}` : `Episodes ${a}–${b}`),
    exportJson: 'Export JSON',
    gatesPass: 'All passed',
    gatesFail: (n) => `${n} failed`,
    gatePill: (okN, total) => `Quality gates ${okN} / ${total}`,
    kpi: {
      segments: 'Segments', segmentsSub: (cap) => `emotional-arc groups, capped at ${cap}s`,
      cuts: 'Shots', cutsSub: (avg) => `${avg}s per shot (one shot one video)`,
      time: 'Estimated total', timeSub: (t) => `target ${t}`,
      batches: 'Generation batches', batchesSub: 'same scene + lighting share one environment reference',
      lines: 'Dialogue segments', linesSub: 'the rest are picture-only',
    },
    secRhythm: 'Shot rhythm strip',
    secSegments: 'Segment cards',
    secBatches: 'Generation batches',
    secDialogue: 'Audio alignment',
    secGates: 'Quality gates',
    rhythmNote: 'thick separators = segment boundaries · slice width = shot duration share · darker = closer shot size',
    segmentsNote: 'segments = emotional-arc groups · each shot: one frame + one seedancePrompt, one shot one video',
    batchesNote: 'auto-computed · segments in a batch share one environment reference image',
    dialogueNote: 'auto-computed · which segment and shot each TTS clip lands on',
    epHead: (nSeg, nCut, total, target) => `${nSeg} segments ${nCut} shots · ${total}s total / ${target}s target`,
    segHead: (total, n) => `${total}s · ${n} shots`,
    secBadge: (secs, n) => `${secs}s · ${n} shots`,
    rhythmVal: (nSeg, nCut, secs) => `${nSeg} seg ${nCut} shots · ${secs}s`,
    beatsLabel: (s, from, to) => `Scene ${s} · ${from === to ? `beat ${from}` : `beats ${from}–${to}`}`,
    masterLabel: 'master frame',
    subLabel: (i) => `sub-frame ${i}`,
    frameMissing: (i) => `#${i} not generated`,
    framePrompt: 'Frame prompt',
    seedancePrompt: 'Seedance prompt',
    promptSection: 'Seedance prompt (per shot)',
    showSegs: '▾ Show all segments',
    hideSegs: '▴ Collapse',
    copy: 'Copy', copied: 'Copied', copyFailed: 'Copy failed',
    dialogueCols: ['Segment · shot', 'Speaker', 'Line', 'Seconds'],
    cutCols: ['Shot', 'Start', 'Sec', 'Size', 'Camera', 'Meta', 'Recipe', 'Picture', 'Characters'],
    batchCols: ['Scene', 'Lighting', 'Segments', 'Characters needed', 'Props'],
    atSec: (t) => `from ${t.toFixed(2)}s`,
    batchLabel: (num) => `Batch ${num}`,
    batchNeed: (chars, props) => `Needs: ${chars.length ? `character sheets for ${chars.join(', ')}` : 'no characters (empty shot)'}${props.length ? ' · ' + props.join(', ') : ''}`,
    voiceOver: 'Voice-over',
    listSep: ', ',
    sizeName: (size) => SHOT_SIZES[size]?.phrase ?? size,
    cameraLabel: (camera) => camera,
    recipeNone: '—',
    recipeName: (card, id) => card?.name_en ?? card?.name ?? id,
    recipeDrift: (sizes, cameras) =>
      `Recipe suggests ${[sizes.length ? `size ${sizes.join(' / ')}` : '', cameras.length ? `camera ${cameras.join(' / ')}` : ''].filter(Boolean).join(' · ')} — advisory, not gated`,
    recipeHint: (n) => `ℹ️ ${n} cut(s) deviate from their recipe's suggested size / camera — a recipe is vocabulary, not law: advisory only (see the ≠ marks in the Recipe column)`,
    speakerLine: (name, text) => `${name}: “${text}”`,
    withLighting: (name, lighting) => (lighting ? `${name} (${lighting})` : name),
    fmtMin: (sec) => `${Math.floor(sec / 60)} min ${Math.round(sec % 60)} s`,
    unitSeg: 'seg',
    unitCut: 'shots',
    colophon: 'Cut by the model from the script: a segment = an emotional-arc group (≤15s), a shot = one video generation (one shot one video, 1–6s), each with one Seedance prompt + one keyframe. Shot-header seconds, the metadata quartet, @bindings, verbatim dialogue and the no-text constraint are all audited deterministically by the script. Frames are generated through codex/Seedream with the scene and character sheets as references.',
  },
};

const tOf = (lang) => {
  if (lang && !I18N[lang]) throw new Error('报告界面语言目前内置 zh / en');
  return I18N[lang ?? 'zh'];
};

/* ------------------------------------------------------------------ */
/* render 公共                                                          */
/* ------------------------------------------------------------------ */

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function namer(ctx = {}, t = I18N.zh) {
  const charName = new Map((ctx.outline?.characters ?? []).map((c) => [c.id, c.name]));
  const sceneName = new Map((ctx.art?.scenes ?? []).map((s) => [s.id, s.name]));
  const propName = new Map((ctx.art?.props ?? []).map((p) => [p.id, p.name]));
  return {
    char: (id) => (id === 'VO' ? t.voiceOver : charName.get(id) ?? id),
    scene: (id) => sceneName.get(id) ?? id,
    prop: (id) => propName.get(id) ?? id,
  };
}

/**
 * cut 的「配方」列：卡名 + 偏离建议景别／运镜时的 ≠ 标记。
 * 偏离只提示不设门——配方是语汇不是法条（理由见 recipeDrift 上方注释）。
 */
function cutRecipe(cut, recipes, t) {
  const id = typeof cut?.recipe === 'string' ? cut.recipe : '';
  if (!id) return null;
  const card = recipes?.get(id) ?? null;
  const off = recipeDrift(cut, card);
  return {
    name: t.recipeName(card, id),
    drift: off.sizes.length || off.cameras.length ? t.recipeDrift(off.sizes, off.cameras) : '',
  };
}

/** 分镜认领的节拍 → 画面摘要（动作原文 + 台词行），模型不重写。 */
function cutBeats(cut, scene) {
  if (!scene) return [];
  const [from, to] = cut.beats ?? [];
  return scene.beats.slice((from ?? 1) - 1, to ?? 0);
}

/* ------------------------------------------------------------------ */
/* render — markdown                                                   */
/* ------------------------------------------------------------------ */

const mdRow = (cells) => `| ${cells.map((c) => String(c ?? '').replace(/\|/g, '\\|')).join(' | ')} |`;
const mdHead = (cols) => [mdRow(cols), mdRow(cols.map(() => '---'))].join('\n');

export function renderMarkdown(board, ctx = {}) {
  const t = tOf(ctx.lang ?? board?.lang);
  const n = namer(ctx, t);
  const expanded = expandScript(ctx.script);
  const stats = computeStats(board, ctx.script);
  const eps = board.episodes;
  const out = [`# ${t.docTitle(board.source, eps[0]?.ep, eps[eps.length - 1]?.ep)}`, ''];

  for (const [i, ep] of eps.entries()) {
    const st = stats.episodes[i];
    const sEp = expanded.get(ep.ep);
    out.push(`## E${String(ep.ep).padStart(2, '0')}`, '', `> ${t.epHead(st.segments, st.cuts, st.totalSeconds, st.target)}`, '');
    for (const seg of ep.segments) {
      const scene = sEp?.scenes?.[seg.sceneIndex - 1];
      out.push(`### ${seg.id} · ${scene ? t.withLighting(n.scene(scene.sceneId), scene.lighting) : '?'} · ${t.segHead(segSeconds(seg), seg.shots.length)}`, '');
      out.push(mdHead(t.cutCols));
      const starts = cutStarts(seg.shots);
      seg.shots.forEach((cut, ci) => {
        const summary = cutBeats(cut, scene)
          .map((b) => (b.kind === 'line' ? t.speakerLine(n.char(b.speaker), b.text) : b.text))
          .join(' ');
        // md 没有 title 属性，偏离的建议值直接写在格子里
        const rc = cutRecipe(cut, ctx.recipes, t);
        const meta = `空间:${cut.space} · 姿态:${cut.pose} · 位置:${cut.position} · 情绪:${cut.mood}`;
        out.push(mdRow([
          `c${String(ci + 1).padStart(2, '0')}`, `${starts[ci].toFixed(2)}s`, cut.seconds,
          t.sizeName(cut.size), t.cameraLabel(cut.camera),
          meta,
          rc ? `${rc.name}${rc.drift ? ` ≠（${rc.drift}）` : ''}` : t.recipeNone,
          summary, (cut.characters ?? []).map(n.char).join(t.listSep),
        ]));
      });
      // 每镜一条 seedancePrompt，直接复制可用
      seg.shots.forEach((cut, ci) => {
        out.push('', `**${t.promptSection} — c${String(ci + 1).padStart(2, '0')}（${cut.seconds}s）**`, '', '```text', cut.seedancePrompt ?? '', '```', '');
      });
    }
  }

  out.push(`## ${t.secBatches}`, '', mdHead(t.batchCols));
  for (const b of stats.batches) {
    out.push(mdRow([`${b.sceneId} ${n.scene(b.sceneId)}`, b.lighting, b.segments.join(t.listSep), b.characters.map(n.char).join(t.listSep), b.props.map(n.prop).join(t.listSep)]));
  }
  out.push('', `## ${t.secDialogue}`, '', mdHead(t.dialogueCols));
  for (const d of stats.dialogue) out.push(mdRow([`${d.segment}#${d.cut}`, n.char(d.speaker), d.line, d.seconds]));
  out.push('');
  return out.join('\n');
}

/* ------------------------------------------------------------------ */
/* render — html                                                       */
/* ------------------------------------------------------------------ */
/*
 * 与另外四份报告同一套视觉语言。设计约定见 references/report-style.md。
 * 分镜图从工作目录下 <段号>/f<切序>.png 找（imageExists 由 CLI 注入，
 * render 时检查相对工作目录的路径），有就内嵌显示 + 点击放大，
 * 没有就显示占位——不猜、不骗。
 */

function embedDoc(doc) {
  return JSON.stringify(doc).replace(/</g, '\\u003c');
}

export function renderHtml(board, ctx = {}) {
  const lang = ctx.lang ?? board?.lang ?? 'zh';
  const t = tOf(lang);
  const n = namer(ctx, t);
  const expanded = expandScript(ctx.script);
  const stats = computeStats(board, ctx.script);
  const gates = gateReport(board, ctx);
  const assets = assetNames(ctx);
  const failed = gates.filter((g) => !g.ok);
  const eps = board.episodes;
  const params = stats.params;
  const fmtMin = t.fmtMin;

  const SIZE_ALPHA = { 'extreme-wide': 0.25, wide: 0.4, medium: 0.58, close: 0.78, 'extreme-close': 1 };

  // ---- 01 分镜节奏带：段是粗分隔的组，组内每个分镜一段色块 ----
  const rhythmRows = eps
    .map((ep, i) => {
      const st = stats.episodes[i];
      const groups = ep.segments
        .map((seg) => {
          const segs = seg.shots
            .map((cut, ci) => {
              const w = st.totalSeconds ? (cut.seconds / st.totalSeconds) * 100 : 0;
              const alpha = SIZE_ALPHA[cut.size] ?? 0.5;
              return `<a class="seg" href="#seg-${esc(seg.id)}" style="width:${r1(w)}%;background:rgba(138,51,36,${alpha})" title="${esc(`${seg.id}#${ci + 1} · ${cut.seconds}s · ${t.sizeName(cut.size)} · ${cut.camera}`)}"></a>`;
            })
            .join('');
          const gw = st.totalSeconds ? (segSeconds(seg) / st.totalSeconds) * 100 : 0;
          return `<span class="rseg" style="width:${r1(gw)}%">${segs}</span>`;
        })
        .join('');
      return `<div class="rrow"><span class="rep">E${String(ep.ep).padStart(2, '0')}</span><div class="rtrack">${groups}</div><span class="rval">${esc(t.rhythmVal(st.segments, st.cuts, st.totalSeconds))}</span></div>`;
    })
    .join('\n');
  const rhythmLegend = Object.keys(SHOT_SIZES)
    .map((k) => `<i><span class="sw" style="background:rgba(138,51,36,${SIZE_ALPHA[k]})"></span>${esc(t.sizeName(k))}</i>`)
    .join('');

  // ---- 02 分集分镜表：段卡（主分镜图 + 子分镜条 + 分镜行） ----
  const epBlocks = eps
    .map((ep, i) => {
      const st = stats.episodes[i];
      const sEp = expanded.get(ep.ep);
      const cards = ep.segments
        .map((seg) => {
          const scene = sEp?.scenes?.[seg.sceneIndex - 1];
          const starts = cutStarts(seg.shots);
          const frame = (ci) => `${seg.id}/f${ci + 1}.png`;
          const has = (ci) => (ctx.imageExists ? ctx.imageExists(frame(ci)) : false);

          // 主分镜图区：图出全的段保留原 master+subs 层级；有缺图的段每切一格——
          // 有图的格显示原图，无图的格显示整宽提示词卡 + 复制按钮（混合情况按格判断）
          const hasAll = seg.shots.every((_, ci) => has(ci));
          let master, subs;
          if (hasAll) {
            master = `<img class="frame" src="${esc(frame(0))}" alt="${esc(`${seg.id}#1`)}" loading="lazy">`;
            subs = seg.shots.length > 1
              ? `<div class="subs">${seg.shots
                  .slice(1)
                  .map((cut, ci) => `<img class="subf" src="${esc(frame(ci + 1))}" alt="${esc(`${seg.id}#${ci + 2}`)}" loading="lazy">`)
                  .join('')}</div>`
              : '';
          } else {
            master = `<div class="fquad">${seg.shots
              .map((cut, ci) => {
                const label = ci === 0 ? t.masterLabel : t.subLabel(ci + 1);
                const body = has(ci)
                  ? `<img class="frame" src="${esc(frame(ci))}" alt="${esc(`${seg.id}#${ci + 1}`)}" loading="lazy">`
                  : `<div class="frame ph fcell"><div class="fcell-h"><b>${esc(`${label} · ${t.frameMissing(ci + 1)}`)}</b><button class="copy mini" data-copy="${esc(cut.frame ?? '')}">${esc(t.copy)}</button></div><span class="fprompt">${esc(cut.frame ?? '')}</span></div>`;
                return body;
              })
              .join('\n')}</div>`;
            subs = '';
          }

          const cutRows = seg.shots
            .map((cut, ci) => {
              const beats = cutBeats(cut, scene);
              const summary = beats
                .map((b) =>
                  b.kind === 'line'
                    ? `<p class="sline"><b>${esc(n.char(b.speaker))}</b>${esc(b.text)}</p>`
                    : `<p class="sact">${esc(b.text)}</p>`,
                )
                .join('');
              // 「配方」列：偏离建议景别／运镜的加 ≠ 上标，建议值写进 title——提示而已，不是门
              const rc = cutRecipe(cut, ctx.recipes, t);
              // 结构化元数据四件套 chips
              const metaChips = [
                ['空间', cut.space], ['姿态', cut.pose], ['位置', cut.position], ['情绪', cut.mood],
              ].map(([k, v]) => (v ? `<span class="chip meta" title="${esc(k)}">${esc(v)}</span>` : '')).join('');
              // @绑定图：元数据/描述/提示词里的 @X → 设定图（images/<名>-sheet.png），有图才嵌，不猜不骗
              const binds = assets.size
                ? [...new Set(checkAtRefs([cut.pose, cut.position, cut.mood, cut.shotDesc, cut.seedancePrompt].join('\n'), assets).known)]
                : [];
              const bindImgs = binds.filter((b) => ctx.imageExists && ctx.imageExists(`images/${b}-sheet.png`));
              return `<li class="cut">
  <div class="cut-h">
    <b>c${String(ci + 1).padStart(2, '0')}</b>
    <span class="cut-t">${esc(t.atSec(starts[ci]))} · ${cut.seconds}s</span>
    <span class="cut-sc">${esc(t.sizeName(cut.size))} · ${esc(cut.camera)}</span>
    ${rc ? `<span class="cut-rc">${esc(rc.name)}${rc.drift ? `<sup title="${esc(rc.drift)}">≠</sup>` : ''}</span>` : ''}
    ${(cut.characters ?? []).map((id) => `<span class="chip">${esc(n.char(id))}</span>`).join('')}
    ${(cut.props ?? []).map((id) => `<span class="chip prop">${esc(n.prop(id))}</span>`).join('')}
    <button class="copy mini" data-copy="${esc(cut.frame ?? '')}">${esc(t.framePrompt)}</button>
  </div>
  ${metaChips ? `<div class="cut-meta">${metaChips}</div>` : ''}
  ${bindImgs.length ? `<div class="cut-binds">${bindImgs.map((b) => `<span class="bind"><img src="${esc(`images/${b}-sheet.png`)}" alt="${esc(b)}" loading="lazy"><i>@${esc(b)}</i></span>`).join('')}</div>` : ''}
  ${summary}
</li>`;
            })
            .join('\n');

          return `<article class="segcard" id="seg-${esc(seg.id)}">
  <header class="seg-h">
    <b>${esc(seg.id)}</b>
    <span class="sec-badge">${esc(t.secBadge(segSeconds(seg), seg.shots.length))}</span>
    <span class="chip">${esc(scene ? `${scene.sceneId} ${n.scene(scene.sceneId)}` : '?')}</span>
    ${scene?.lighting ? `<span class="chip lite">${esc(scene.lighting)}</span>` : ''}
    <span class="beatsref">${esc(t.beatsLabel(seg.sceneIndex, seg.shots[0]?.beats?.[0], seg.shots[seg.shots.length - 1]?.beats?.[1]))}</span>
  </header>
  ${master}
  ${subs}
  <div class="duo">
    <ol class="cuts">
${cutRows}
    </ol>
    <div class="pplist">
      ${seg.shots
        .map((cut, pci) => `<div class="ppanel">
  <div class="pp-h">
    <b>${esc(t.promptSection)} — c${String(pci + 1).padStart(2, '0')}（${cut.seconds}s）</b>
    <button class="copy" data-copy="${esc(cut.seedancePrompt ?? '')}">${esc(t.copy)}</button>
  </div>
  <pre class="pp on">${esc(cut.seedancePrompt ?? '')}</pre>
</div>`)
        .join('\n')}
    </div>
  </div>
  ${seg.note ? `<p class="seg-note">${esc(seg.note)}</p>` : ''}
</article>`;
        })
        .join('\n');
      return `<section class="ep" id="ep-${ep.ep}">
  <header class="ep-h">
    <span class="ep-n">E${String(ep.ep).padStart(2, '0')}</span>
    <span class="ep-est">${esc(t.epHead(st.segments, st.cuts, st.totalSeconds, st.target))}</span>
  </header>
  <div class="shots clip">
    <div class="seggrid">
${cards}
    </div>
  </div>
  <button class="shmore">${esc(t.showSegs)}</button>
</section>`;
    })
    .join('\n');

  // ---- 03 生成批次单 ----
  const batchCards = stats.batches
    .map((b, i) => {
      const sheet = `images/${slug(n.scene(b.sceneId))}-sheet.png`;
      const hasSheet = ctx.imageExists ? ctx.imageExists(sheet) : false;
      return `<article class="batch">
  ${hasSheet ? `<img class="bimg" src="${esc(sheet)}" alt="${esc(n.scene(b.sceneId))}" loading="lazy">` : ''}
  <header class="batch-h"><b>${esc(t.batchLabel(String(i + 1).padStart(2, '0')))}</b><span class="chip">${esc(`${b.sceneId} ${n.scene(b.sceneId)}`)}</span>${b.lighting ? `<span class="chip lite">${esc(b.lighting)}</span>` : ''}</header>
  <div class="batch-shots">${b.segments.map((s) => `<a class="chip mono" href="#seg-${esc(s)}">${esc(s)}</a>`).join('')}</div>
  <p class="batch-need">${esc(t.batchNeed(b.characters.map(n.char), b.props.map(n.prop)))}</p>
</article>`;
    })
    .join('\n');

  // ---- 04 配音对齐单 ----
  const dlgRows = stats.dialogue
    .map((d) => `<tr><td><a href="#seg-${esc(d.segment)}">${esc(d.segment)}</a> #${d.cut}</td><td>${esc(n.char(d.speaker))}</td><td class="serif">${esc(d.line)}</td><td>${d.seconds}</td></tr>`)
    .join('\n');

  const gateList = `<ul class="gate">
  ${gates
    .map(
      // 通过的门只有跳过说明与「没有引用配方」这类备注带 detail——都要显示出来，不静默
      (g) => `<li class="${g.ok ? 'ok' : 'bad'}"><span class="m">${g.ok ? '✓' : '✗'}</span><span>${esc(gateText(g, t.langCode).label)}${
        g.detail ? `<small>${esc(gateText(g, t.langCode).detail)}</small>` : ''
      }</span></li>`,
    )
    .join('\n  ')}
</ul>`;

  return `<!doctype html>
<html lang="${esc(lang)}"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(t.docTitle(board.source, eps[0]?.ep, eps[eps.length - 1]?.ep))}</title>
<style>
:root{
  --paper:#eceded; --panel:#f5f6f5; --side:#e4e6e3; --ink:#191d21; --ink-2:#5b636a; --ink-3:#8c9298;
  --rule:#d2d5d0; --rule-2:#c2c6bf; --seal:#8a3324; --seal-2:#c56a4e; --seal-soft:#8a332412; --ok:#3d6b4f;
  --serif:"Songti SC","STSong","Source Han Serif SC","Noto Serif CJK SC",Georgia,serif;
  --sans:"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,-apple-system,sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.7 var(--sans);-webkit-font-smoothing:antialiased}
.page{max-width:1600px;margin:0 auto;padding:24px 32px 90px}
h1,h2,h3{margin:0;font-weight:400}

.hd{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;border-bottom:2px solid var(--ink);padding-bottom:12px}
.hd h1{font:400 28px/1.1 var(--serif);letter-spacing:.06em}
.hd .sub{font-size:13px;color:var(--ink-2)}
.hd .right{margin-left:auto;display:flex;align-items:center;gap:10px}
.gatepill{display:inline-flex;align-items:center;gap:6px;font:500 12px/1 var(--sans);border-radius:99px;padding:6px 12px}
.gatepill.pass{color:var(--ok);border:1px solid var(--ok)}
.gatepill.fail{color:var(--seal);border:1px solid var(--seal);background:var(--seal-soft)}
.expo{font:500 11px/1 var(--sans);color:var(--ink-2);background:var(--panel);
  border:1px solid var(--rule-2);border-radius:2px;padding:7px 11px;cursor:pointer;transition:.15s}
.expo:hover{border-color:var(--seal);color:var(--seal)}
.expo:focus-visible{outline:2px solid var(--seal);outline-offset:2px}

.kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin:18px 0 6px}
@media(max-width:980px){.kpis{grid-template-columns:repeat(2,1fr)}}
.kpi{background:var(--panel);border:1px solid var(--rule);border-radius:2px;padding:11px 14px 9px}
.kpi .l{font:500 10px/1 var(--sans);letter-spacing:.18em;color:var(--ink-3)}
.kpi .v{font:400 28px/1.15 var(--serif);margin-top:5px}
.kpi .v small{font:400 14px var(--serif);color:var(--ink-2)}
.kpi .d{font-size:11px;color:var(--ink-2);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kpi.accent{border-top:2px solid var(--seal)}
.galert{margin:14px 0 0;border:1px solid var(--seal);background:var(--seal-soft);border-radius:2px;
  padding:10px 14px;font-size:13px}
.galert b{color:var(--seal)}
.galert span{display:block;font-size:12px;color:var(--ink-2)}

section.top-sec{margin-top:34px}
.sec-h{display:flex;align-items:baseline;gap:12px;border-bottom:1px solid var(--rule-2);padding-bottom:8px;margin-bottom:16px}
.sec-h .no{font:500 12px/1 var(--mono);color:var(--seal)}
.sec-h h2{font:400 20px/1.2 var(--serif);letter-spacing:.05em}
.sec-h .note{margin-left:auto;font-size:12px;color:var(--ink-3)}

/* 01 cut rhythm strip */
.rhythm{background:var(--panel);border:1px solid var(--rule);border-radius:2px;padding:16px 20px 10px}
.rrow{display:grid;grid-template-columns:44px minmax(0,1fr) 150px;gap:12px;align-items:center;padding:5px 0}
.rep{font:500 12px/1 var(--mono);color:var(--ink-2)}
.rtrack{display:flex;height:22px;border:1px solid var(--rule);border-radius:2px;overflow:hidden;background:var(--paper)}
.rseg{display:flex;border-right:2px solid var(--ink-2)}
.rseg:last-child{border-right:0}
.seg{display:block;border-right:1px solid var(--panel)}
.rseg .seg:last-child{border-right:0}
.seg:hover{outline:2px solid var(--ink);outline-offset:-2px}
.rval{font:500 12px/1.5 var(--sans);color:var(--ink-2)}
.legend{display:flex;gap:16px;font-size:12px;color:var(--ink-2);margin:8px 0 2px;flex-wrap:wrap}
.legend i{font-style:normal;display:inline-flex;align-items:center;gap:6px}
.sw{display:inline-block;width:10px;height:10px;border-radius:2px}

/* 02 segment cards */
.ep{background:var(--panel);border:1px solid var(--rule);border-radius:2px;padding:18px 22px;margin-bottom:16px}
.ep-h{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;border-bottom:1px solid var(--rule-2);padding-bottom:10px;margin-bottom:14px}
.ep-n{font:400 22px/1 var(--serif);letter-spacing:.04em;color:var(--seal)}
.ep-est{font-size:12.5px;color:var(--ink-2)}
.shots{position:relative}
.shots.clip{max-height:760px;overflow:hidden}
.shots.clip::after{content:'';position:absolute;left:0;right:0;bottom:0;height:80px;
  background:linear-gradient(180deg,transparent,var(--panel));pointer-events:none}
.shmore{display:block;width:100%;margin-top:8px;font:500 11.5px/1 var(--sans);letter-spacing:.06em;
  color:var(--ink-2);background:var(--paper);border:1px solid var(--rule-2);border-radius:2px;
  padding:7px 0;cursor:pointer;transition:.15s}
.shmore:hover{border-color:var(--seal);color:var(--seal)}
.shmore:focus-visible{outline:2px solid var(--seal);outline-offset:2px}
.seggrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-items:start}
@media(max-width:1100px){.seggrid{grid-template-columns:minmax(0,1fr)}}
.segcard{background:var(--paper);border:1px solid var(--rule);border-radius:2px;padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.seg-h{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.seg-h b{font:500 14px/1 var(--mono);color:var(--seal)}
.sec-badge{font:500 11px/1 var(--mono);border:1px solid var(--seal);color:var(--seal);border-radius:99px;padding:2px 8px}
.beatsref{margin-left:auto;font-size:10.5px;color:var(--ink-3)}
.frame{width:100%;aspect-ratio:16/9;object-fit:cover;border:1px solid var(--rule-2);border-radius:2px;
  cursor:zoom-in;display:block;background:var(--side)}
.frame.ph{display:flex;flex-direction:column;gap:6px;padding:10px 12px;cursor:default;overflow:hidden}
.frame.ph b{font:500 10px/1 var(--sans);letter-spacing:.14em;color:var(--ink-3)}
.frame.ph span{font:400 10.5px/1.55 var(--mono);color:var(--ink-2);overflow:hidden;display:-webkit-box;
  -webkit-line-clamp:5;-webkit-box-orient:vertical}
.subs{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}
.fquad{display:grid;grid-template-columns:1fr;gap:10px;margin:10px 0}
.fquad .frame.ph{aspect-ratio:auto}
.fquad .fcell{margin:0;min-height:0}
.fcell-h{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px}
.fcell-h .copy.mini{margin:0;flex:none}
.frame.ph .fprompt{font:400 10.5px/1.4 var(--mono);color:var(--ink-2);white-space:pre-wrap;word-break:break-word;display:block;
  -webkit-line-clamp:none;-webkit-box-orient:vertical;overflow:visible}
.subf{width:100%;aspect-ratio:16/9;object-fit:cover;border:1px solid var(--rule-2);border-radius:2px;
  cursor:zoom-in;display:block;background:var(--side)}
.subf.ph{display:flex;align-items:center;justify-content:center;cursor:default;
  font:500 10px/1 var(--sans);color:var(--ink-3);letter-spacing:.08em}
.duo{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;align-items:start;border-top:1px solid var(--rule);padding-top:4px}
@media(max-width:900px){.duo{grid-template-columns:minmax(0,1fr)}}
.ppanel{border:1px solid var(--rule);border-radius:2px;background:var(--panel);margin-top:7px}
.pp-h{display:flex;align-items:center;gap:6px;padding:7px 10px;border-bottom:1px solid var(--rule)}
.pp-h b{font:500 11px/1 var(--sans);letter-spacing:.08em;color:var(--ink-2);margin-right:auto}
.pp{display:none;margin:0;padding:9px 12px;font:400 12px/1.8 var(--sans);color:var(--ink);
  white-space:pre-wrap;word-break:break-word;max-height:400px;overflow-y:auto;
  scrollbar-width:thin;scrollbar-color:var(--rule-2) transparent}
.pp.on{display:block}
.pp::-webkit-scrollbar{width:6px}
.pp::-webkit-scrollbar-thumb{background:var(--rule-2);border-radius:3px}
.cuts{margin:0;padding:0;list-style:none}
.cut{padding:7px 0;border-bottom:1px solid var(--rule)}
.cut:first-child{padding-top:11px}
.cut:last-child{border-bottom:0}
.cut-h{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.cut-h b{font:500 12px/1 var(--mono);color:var(--seal)}
.cut-t{font:500 10.5px/1.6 var(--mono);color:var(--ink-3)}
.cut-sc{font-size:11.5px;color:var(--ink-2)}
.cut-rc{font:400 10.5px/1.6 var(--mono);border:1px dashed var(--rule-2);border-radius:2px;padding:0 6px;color:var(--ink-2)}
.cut-rc sup{color:var(--seal-2);font-weight:700;cursor:help;margin-left:2px}
.cut-h .copy{margin-left:auto;opacity:0;transition:.15s}
.cut:hover .copy{opacity:1}
.cut p{margin:3px 0 0;font-size:12px;line-height:1.6}
.cut-meta{display:flex;flex-wrap:wrap;gap:4px;margin:4px 0 0}
.cut-meta .chip.meta{border-color:var(--seal-2);color:var(--seal-2);font-size:10px}
.cut-binds{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 0}
.bind{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--rule-2);border-radius:2px;padding:2px 6px 2px 2px;background:var(--panel)}
.bind img{width:26px;height:26px;object-fit:cover;border-radius:2px;cursor:zoom-in}
.bind i{font:400 10px/1 var(--sans);color:var(--ink-2);font-style:normal}
.pplist{display:flex;flex-direction:column;gap:8px;margin-top:7px}
.sact{color:var(--ink-2)}
.sline{font-family:var(--serif)}
.sline b{font-weight:500;margin-right:6px;color:var(--seal)}
.chip{font:400 10.5px/1.6 var(--mono);border:1px solid var(--rule-2);border-radius:2px;
  padding:0 6px;background:var(--panel);color:var(--ink-2);text-decoration:none}
.chip.lite{border-color:var(--seal-2);color:var(--seal-2)}
.chip.prop{border-color:var(--seal);color:var(--seal)}
.chip.mono{font-family:var(--mono)}
a.chip:hover{border-color:var(--seal);color:var(--seal)}
.prompts{display:flex;gap:6px}
.seg-note{margin:0;font-size:11px;color:var(--ink-3)}

/* 03 generation batches */
.batches{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-items:start}
@media(max-width:1100px){.batches{grid-template-columns:minmax(0,1fr)}}
.batch{background:var(--panel);border:1px solid var(--rule);border-radius:2px;padding:14px 18px}
.bimg{width:100%;aspect-ratio:16/9;object-fit:cover;border:1px solid var(--rule-2);border-radius:2px;
  cursor:zoom-in;display:block;margin-bottom:10px}
.batch-h{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.batch-h b{font:500 13px var(--serif);letter-spacing:.06em}
.batch-shots{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
.batch-need{margin:8px 0 0;font-size:12px;color:var(--ink-2)}

/* 04 audio alignment */
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--rule);font-size:13px}
th,td{padding:8px 12px;border-bottom:1px solid var(--rule);text-align:left;vertical-align:top}
th{font:500 11px/1 var(--sans);letter-spacing:.1em;color:var(--ink-3);background:var(--side)}
tr:last-child td{border-bottom:0}
td:first-child{font-family:var(--mono);font-size:12px;white-space:nowrap}
td a{color:var(--seal);text-decoration:none}
td.serif{font-family:var(--serif)}

.copy{flex:none;font:500 11px/1 var(--sans);color:var(--ink-2);background:var(--panel);
  border:1px solid var(--rule-2);border-radius:2px;padding:5px 10px;cursor:pointer;transition:.15s}
.copy:hover{border-color:var(--seal);color:var(--seal)}
.copy:focus-visible{outline:2px solid var(--seal);outline-offset:2px}
.copy[data-done]{border-color:var(--seal);color:var(--seal)}
.copy.mini{padding:3px 7px;font-size:10px}

.gate{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:2px 28px}
@media(max-width:900px){.gate{grid-template-columns:1fr}}
.gate li{display:flex;gap:8px;padding:5px 0;font-size:12.5px;line-height:1.55}
.gate .m{flex:none;font-weight:700}
.gate li.ok .m{color:var(--ok)}
.gate li.bad .m{color:var(--seal)}
.gate li.bad{background:var(--seal-soft);border-radius:2px;padding-left:6px}
.gate small{display:block;color:var(--ink-3)}
.gsum{margin:10px 0 0;font-size:12px;color:var(--ink-2)}
.gsum b{color:var(--seal)}

.lightbox{position:fixed;inset:0;background:rgba(20,22,24,.88);display:none;align-items:center;
  justify-content:center;z-index:9;cursor:zoom-out;padding:32px}
.lightbox.on{display:flex}
.lightbox img{max-width:96%;max-height:96%;border:1px solid #555;border-radius:2px}

.foot{margin-top:40px;font-size:11px;color:var(--ink-3);border-top:1px solid var(--rule);padding-top:14px}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
@media print{
  .expo,.copy,.shmore{display:none!important}
  .pp{max-height:none;overflow:visible}
  .duo{grid-template-columns:minmax(0,1fr)}
  .shots.clip{max-height:none}
  .shots.clip::after{display:none}
  .seggrid,.batches{grid-template-columns:minmax(0,1fr)}
  .page{max-width:none;padding:0}
  section.top-sec,.segcard,.batch{page-break-inside:avoid}
  body{background:#fff}
}
</style></head><body>
<div class="page">

<header class="hd">
  <h1>${esc(board.source)}</h1>
  <span class="sub">${esc(t.kicker)} · ${esc(t.epRange(eps[0]?.ep, eps[eps.length - 1]?.ep))}</span>
  <span class="right">
    <span class="gatepill ${failed.length ? 'fail' : 'pass'}">${failed.length ? '✗' : '✓'} ${esc(t.gatePill(gates.length - failed.length, gates.length))}</span>
    <button class="expo" data-name="${esc(slug(board.source))}-storyboard.json">${esc(t.exportJson)}</button>
  </span>
</header>

<div class="kpis">
  <div class="kpi accent"><div class="l">${esc(t.kpi.segments)}</div><div class="v">${stats.totals.segments} <small>${esc(t.unitSeg)}</small></div><div class="d">${esc(t.kpi.segmentsSub(params.maxSegmentSeconds))}</div></div>
  <div class="kpi"><div class="l">${esc(t.kpi.cuts)}</div><div class="v">${stats.totals.cuts} <small>${esc(t.unitCut)}</small></div><div class="d">${esc(t.kpi.cutsSub(stats.totals.avgCutSeconds))}</div></div>
  <div class="kpi"><div class="l">${esc(t.kpi.time)}</div><div class="v">${esc(fmtMin(stats.totals.seconds))}</div><div class="d">${esc(t.kpi.timeSub(fmtMin(stats.totals.targetSeconds)))}</div></div>
  <div class="kpi"><div class="l">${esc(t.kpi.batches)}</div><div class="v">${stats.batches.length}</div><div class="d">${esc(t.kpi.batchesSub)}</div></div>
  <div class="kpi"><div class="l">${esc(t.kpi.lines)}</div><div class="v">${stats.totals.withLines} <small>${esc(t.unitSeg)}</small></div><div class="d">${esc(t.kpi.linesSub)}</div></div>
</div>
${failed.length ? `<div class="galert"><b>✗ ${esc(t.gatesFail(failed.length))}</b>${failed.map((g) => `<span>${esc(gateText(g, t.langCode).label)}${g.detail ? ` — ${esc(gateText(g, t.langCode).detail)}` : ''}</span>`).join('')}</div>` : ''}

<section class="top-sec" id="sec-rhythm">
  <div class="sec-h"><span class="no">01</span><h2>${esc(t.secRhythm)}</h2><span class="note">${esc(t.rhythmNote)}</span></div>
  <div class="rhythm">
    <div class="legend">${rhythmLegend}</div>
${rhythmRows}
  </div>
</section>

<section class="top-sec" id="sec-segments">
  <div class="sec-h"><span class="no">02</span><h2>${esc(t.secSegments)}</h2><span class="note">${esc(t.segmentsNote)}</span></div>
${epBlocks}
</section>

<section class="top-sec" id="sec-batches">
  <div class="sec-h"><span class="no">03</span><h2>${esc(t.secBatches)}</h2><span class="note">${esc(t.batchesNote)}</span></div>
  <div class="batches">
${batchCards}
  </div>
</section>

<section class="top-sec" id="sec-dialogue">
  <div class="sec-h"><span class="no">04</span><h2>${esc(t.secDialogue)}</h2><span class="note">${esc(t.dialogueNote)}</span></div>
  <table><thead><tr>${t.dialogueCols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
  <tbody>
${dlgRows}
  </tbody></table>
</section>

<section class="top-sec" id="sec-gates">
  <div class="sec-h"><span class="no">05</span><h2>${esc(t.secGates)}</h2></div>
  ${gateList}
  <p class="gsum">${failed.length ? `<b>${esc(t.gatesFail(failed.length))}</b>` : esc(t.gatesPass)}</p>
</section>

<p class="foot">${esc(t.colophon)}</p>
</div>

<div class="lightbox" id="lightbox"><img alt=""></div>

<script type="application/json" id="storyboard-data">${embedDoc(board)}</script>
<script>
const L = ${JSON.stringify({ copied: t.copied, failed: t.copyFailed, show: t.showSegs, hide: t.hideSegs })};

// 分集分镜表：段卡区默认最多 760px。不超高的集直接放开；超高的集点开/收起
document.querySelectorAll('.shmore').forEach((btn) => {
  const zone = btn.previousElementSibling;
  if (zone.scrollHeight <= 780) {
    zone.classList.remove('clip');
    btn.remove();
    return;
  }
  btn.addEventListener('click', () => {
    const clipped = zone.classList.toggle('clip');
    btn.textContent = clipped ? L.show : L.hide;
    if (clipped) zone.closest('.ep').scrollIntoView({ block: 'nearest' });
  });
});

// 点图放大（主分镜图 / 子分镜图 / 批次场景图 / @绑定设定图）
const lb = document.getElementById('lightbox');
document.addEventListener('click', (e) => {
  const img = e.target.closest('img.frame, img.subf, img.bimg, .bind img');
  if (img) {
    lb.querySelector('img').src = img.src;
    lb.classList.add('on');
    return;
  }
  if (e.target.closest('#lightbox')) lb.classList.remove('on');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') lb.classList.remove('on');
});

// 复制提示词
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.copy');
  if (!btn) return;
  e.preventDefault();
  const label = btn.textContent;
  try {
    await navigator.clipboard.writeText(btn.dataset.copy);
    btn.textContent = L.copied;
    btn.dataset.done = '1';
  } catch {
    btn.textContent = L.failed;
  }
  setTimeout(() => { btn.textContent = label; delete btn.dataset.done; }, 1600);
});

// 导出：报告自己带着完整的 storyboard.json，下载的是它原样
document.querySelector('.expo').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  const url = URL.createObjectURL(
    new Blob([document.getElementById('storyboard-data').textContent], { type: 'application/json' }),
  );
  const a = Object.assign(document.createElement('a'), { href: url, download: btn.dataset.name });
  a.click();
  // 别立刻回收——Safari 会抢在下载读完之前撤掉 blob
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});
</script>
</body></html>`;
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const USAGE = `novel-storyboard.mjs — novel-storyboard skill 的确定性工具（分镜）

  seed <script.json> [--eps 1-3]              从剧本预填节拍工作底稿（打印到 stdout）
  validate <sb.json> --script <script.json>   校验；有违规逐条打印并 exit 1
           [--outline] [--cast] [--art]       outline/cast 查提示词人名；art 只管显示名字
           [--shots <卡片目录>]                挂载镜头配方卡库，开 shot-recipe 门（不给就跳过）
  checkup <sb.json> --script <script.json>    只打印质量门 ✓/✗，有未过项 exit 1
          [--shots <卡片目录>]
  render <sb.json> --script <script.json>     渲染报告到 stdout（默认 --md）
         [--html|--md] [--outline] [--art]    分镜图从 ./<段号>/f<切序>.png 找
         [--lang zh|en]                       报告界面语言（默认 zh；未指定时读取 JSON 顶层 lang 字段）
         [--shots <卡片目录>]                  报告的「配方」列显示卡名并标注建议景别／运镜的偏离
  export <sb.json> --script <script.json>     导出 Seedance 投产包：每段一个文件夹 <段号>/prompt-NN.md
         [--out .]                            （每镜一条，与分镜图 f1..fN.png 一一对应）+ 根部 manifest.json
  stats                                       读当前目录的 .gates.jsonl，汇总哪道门最常响、
                                              哪道门从没响过（validate/checkup 会自动累积）
  slug <name>                                 剧名转安全文件名

validate 与 checkup 每次都会把门的结果追加到当前目录的 .gates.jsonl。
积累几十次之后跑 stats，就知道模型最常违反哪条规则——那条规则的措辞该改。
不想记就加 --no-log；写不进去会静默跳过，不影响校验本身。`;

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

function flag(rest, name, fallback = null) {
  const i = rest.indexOf(name);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : fallback;
}

/*
 * --shots 只接受卡片目录，不接受导出的 shots.json：中间产物必然会漂，
 * 卡片 .md 才是唯一来源。目录里读不到卡片就直接报错——挂了却没生效
 * 比没挂更坏。
 */
function loadShots(dir) {
  if (/\.json$/i.test(dir)) {
    throw new Error('--shots 只接受卡片目录（shot-recipes/references/cards），不接受导出的 shots.json——中间产物必然会漂');
  }
  const cards = loadRecipes(dir);
  if (!cards.size) throw new Error(`--shots ${dir} 里没读到卡片（.md）——请指向 shot-recipes/references/cards`);
  return cards;
}

function loadCtx(rest) {
  const get = (name) => {
    const path = flag(rest, name);
    return path ? readJson(path) : null;
  };
  const shots = flag(rest, '--shots');
  return {
    script: get('--script'), outline: get('--outline'), cast: get('--cast'), art: get('--art'),
    recipes: shots ? loadShots(shots) : null,
  };
}

function main(argv) {
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === '-h' || cmd === '--help') {
    console.log(USAGE);
    process.exit(cmd ? 0 : 1);
  }

  if (cmd === 'seed') {
    const [path] = rest;
    if (!path) throw new Error('用法：seed <script.json> [--eps 1-3]');
    const range = flag(rest, '--eps');
    let epRange = null;
    if (range) {
      const m = String(range).match(/^(\d+)-(\d+)$/) ?? String(range).match(/^(\d+)$/);
      if (!m) throw new Error('--eps 形如 3 或 1-6');
      epRange = m[2] ? [Number(m[1]), Number(m[2])] : [Number(m[1]), Number(m[1])];
    }
    console.log(JSON.stringify(seedFromScript(readJson(path), epRange), null, 2));
    return;
  }

  if (cmd === 'validate' || cmd === 'checkup') {
    const [path] = rest;
    if (!path) throw new Error(`用法：${cmd} <storyboard.json> --script <script.json> [--outline] [--cast]`);
    const board = readJson(path);
    const ctx = loadCtx(rest);
    if (!ctx.script) throw new Error('分镜离开剧本没有意义——必须给 --script <script.json>');
    if (!ctx.outline && !ctx.cast) console.error('⚠️ 没给 --outline / --cast，跳过提示词人名检查');

    // 门的结果追加到 .gates.jsonl——validate 与 checkup 都记，
    // 这样「跑过多少次」这个分母才是全的
    const logGates = (gates) => {
      if (rest.includes('--no-log')) return;
      try {
        const rows = gateLogEntries(gates, { doc: basename(path), at: new Date().toISOString() });
        if (rows.length) appendFileSync(GATE_LOG, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      } catch { /* 写不进去就算了，日志不能挡住主流程 */ }
    };

    if (cmd === 'checkup') {
      const gates = gateReport(board, ctx);
      logGates(gates);
      for (const g of gates) console.log(`${g.ok ? '✓' : '✗'} ${g.label}${g.detail ? ` — ${g.detail}` : ''}`);
      const failedN = gates.filter((g) => !g.ok).length;
      console.log(failedN ? `\n✗ ${failedN} 项未过` : '\n✓ 全部通过');
      // 建议景别／运镜的偏离只在这里提示，不进门——配方是语汇不是法条，
      // 而且可选挂载的东西一旦变严就没人挂了
      if (ctx.recipes) {
        const drifted = [];
        for (const ep of board?.episodes ?? []) {
          for (const seg of ep?.segments ?? []) {
            (seg?.shots ?? []).forEach((cut, ci) => {
              const card = typeof cut?.recipe === 'string' ? ctx.recipes.get(cut.recipe) : null;
              if (!card) return;
              const d = recipeDrift(cut, card);
              if (d.sizes.length || d.cameras.length) {
                drifted.push(`  ${seg.id}#${ci + 1}「${card.name}」${I18N.zh.recipeDrift(d.sizes, d.cameras)}`);
              }
            });
          }
        }
        if (drifted.length) console.error(`\n${I18N.zh.recipeHint(drifted.length)}\n${drifted.join('\n')}`);
      }
      if (failedN) process.exit(1);
      return;
    }

    logGates(gateReport(board, ctx));
    const problems = validateStoryboard(board, ctx);
    if (problems.length) {
      console.error(`✗ ${problems.length} 处违规：\n`);
      for (const x of problems) console.error('  ' + x);
      process.exit(1);
    }
    const st = computeStats(board, ctx.script);
    console.log(`✓ ${st.episodes.length} 集 / ${st.totals.segments} 段 / ${st.totals.cuts} 个分镜全部通过校验（共 ${st.totals.seconds}s / 目标 ${st.totals.targetSeconds}s / ${st.batches.length} 个生成批次）`);
    return;
  }

  if (cmd === 'render') {
    const [path] = rest;
    if (!path) throw new Error('用法：render <storyboard.json> --script <script.json> [--html|--md] [--lang zh|en] [--outline] [--art]');
    const board = readJson(path);
    const ctx = loadCtx(rest);
    if (!ctx.script) throw new Error('分镜离开剧本没有意义——必须给 --script <script.json>');
    // 界面语言：--lang > JSON 顶层 lang 字段 > 'zh'（后两级在渲染器里兜底）
    const langFlag = flag(rest, '--lang');
    if (langFlag) ctx.lang = langFlag;
    ctx.imageExists = (rel) => existsSync(resolve(rel));
    process.stdout.write((rest.includes('--html') ? renderHtml(board, ctx) : renderMarkdown(board, ctx)) + '\n');
    return;
  }

  if (cmd === 'export') {
    const [path] = rest;
    if (!path) throw new Error('用法：export <storyboard.json> --script <script.json> [--out .]');
    const board = readJson(path);
    const ctx = loadCtx(rest);
    if (!ctx.script) throw new Error('分镜离开剧本没有意义——必须给 --script <script.json>');
    const dir = flag(rest, '--out', '.');
    const pack = exportPack(board, ctx.script, { imageExists: (rel) => existsSync(resolve(rel)), dir, assets: assetNames(ctx) });
    for (const f of pack.files) {
      mkdirSync(resolve(f.path, '..'), { recursive: true });
      writeFileSync(resolve(f.path), f.content, 'utf8');
    }
    const shotN = pack.manifest.length;
    console.log(`✓ ${shotN} 镜投产包 → ${resolve(dir)}/（每段一个文件夹：分镜图 f1..fN.png + prompt-NN.md；根部 manifest.json）`);
    if (pack.missingTotal) console.log(`⚠️ 缺 ${pack.missingTotal} 张分镜图，已在 manifest 的 missing 里标注——喂 Seedance 前先补齐`);
    return;
  }

  if (cmd === 'stats') {
    let entries = [];
    try {
      entries = readFileSync(GATE_LOG, 'utf8').split('\n').filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    } catch {
      console.log(`还没有 ${GATE_LOG}——先在这个目录里跑几次 validate 或 checkup，门的失败会累积到这里。`);
      return;
    }
    const allGates = gateReport({ episodes: [] }, {}).map((g) => g.id);
    const s = summarizeGateLog(entries, allGates);
    console.log(`跑过 ${s.runs} 次，其中 ${s.cleanRuns} 次全过 · 累计 ${s.fails} 条失败\n`);
    if (s.ranked.length) {
      console.log('最常响的门（那条规则模型最常无视，措辞该改）：');
      for (const r of s.ranked) {
        console.log(`  ${String(r.count).padStart(3)} 次  ${r.gate.padEnd(16)} ${r.label}`);
        for (const x of r.samples) console.log(`         ${x.length > 90 ? x.slice(0, 90) + '…' : x}`);
      }
      console.log();
    }
    if (s.silent.length) {
      console.log(`从没响过的门（${s.silent.length} / ${allGates.length}）——可能是死门，也可能规则已经被模型内化：`);
      console.log('  ' + s.silent.join(' / '));
    }
    return;
  }

  if (cmd === 'slug') {
    if (!rest[0]) throw new Error('用法：slug <name>');
    console.log(slug(rest[0]));
    return;
  }

  throw new Error(`未知命令 ${cmd}\n\n${USAGE}`);
}

// 软链安装时 argv[1] 是链接路径，两边都取 realpath 才能比得上
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  // `render ... | head` 这类管道提前关闭时安静退出，别甩 EPIPE 堆栈
  process.stdout.on('error', (e) => {
    if (e.code === 'EPIPE') process.exit(0);
    throw e;
  });
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
