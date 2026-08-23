#!/usr/bin/env node
// novel-storyboard 自测：不调模型、不花额度，只验确定性逻辑。
// 原则与仓库里其他 skill 一致：每道质量门都要有击穿用例——
// 证明它真的会拦，不是一个永远为真的假测试。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAMERA_MOVES,
  DEFAULT_PARAMS,
  SHOT_SIZES,
  assetNames,
  checkAtRefs,
  computeStats,
  cutStarts,
  expandScript,
  exportPack,
  GATE_LOG,
  gateLogEntries,
  gateReport,
  summarizeGateLog,
  loadRecipes,
  parseCardFields,
  paramsOf,
  recipeDrift,
  renderHtml,
  renderMarkdown,
  seedFromScript,
  segSeconds,
  slug,
  validateStoryboard,
} from './novel-storyboard.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(here, '../examples/渡口-storyboard.json'), 'utf8'));
const SCRIPT = JSON.parse(readFileSync(join(here, '../../novel-script/examples/渡口-script.json'), 'utf8'));
const OUTLINE = JSON.parse(readFileSync(join(here, '../../novel-outline/examples/渡口-outline.json'), 'utf8'));
const CAST = JSON.parse(readFileSync(join(here, '../../novel-characters/examples/渡口-cast.json'), 'utf8'));
const ART = JSON.parse(readFileSync(join(here, '../../novel-art/examples/渡口-art.json'), 'utf8'));
const CTX = { script: SCRIPT, outline: OUTLINE, cast: CAST, art: ART };

let passed = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  passed += 1;
}
function eq(actual, expected, label) {
  assert.equal(actual, expected, `${label} — 期望 ${expected}，实际 ${actual}`);
  passed += 1;
}
const clone = (x) => structuredClone(x);
const gate = (doc, id, ctx = CTX) => gateReport(doc, ctx).find((g) => g.id === id);

/* ---------------- expandScript ---------------- */

const expanded = expandScript(SCRIPT);
eq(expanded.size, 6, '剧本六集全部展开');
const e1 = expanded.get(1);
eq(e1.scenes.length, 2, '第 1 集两场');
eq(e1.scenes[0].beats.length, 13, '第 1 场 13 拍');
eq(e1.scenes[1].beats.length, 22, '第 2 场 22 拍');
eq(e1.scenes[0].beats[0].kind, 'action', '第 1 拍是动作');
eq(e1.scenes[0].beats[2].speaker, 'C03', '台词带说话人');
eq(e1.targetSeconds, 120, '目标秒数带出来');
eq(expandScript(null).size, 0, '空剧本不崩');

/* ---------------- 切点时刻 ---------------- */

eq(cutStarts([{ seconds: 3 }, { seconds: 4 }, { seconds: 3 }]).join(','), '0,3,7', '切点 = 前面镜秒数累计');
eq(segSeconds({ shots: [{ seconds: 3 }, { seconds: 4.5 }] }), 7.5, '段秒数 = 镜求和');

/* ---------------- @绑定 / 资产库 ---------------- */

{
  const assets = assetNames(CTX);
  ok(assets.has('沈知微') && assets.has('胡二爷'), 'cast 角色名进资产库');
  ok(assets.has('老伯') && assets.has('姑娘'), 'cast 别名也进资产库');
  ok(assets.has('旧皮箱'), 'art 道具名进资产库');
  eq(assetNames({}).size, 0, '空 ctx 资产库为空');
}
{
  const assets = assetNames(CTX);
  const r = checkAtRefs('@老周-蹲在船头; @旧皮箱 抱紧; @胡二爷-挑担', assets);
  eq(r.known.join(','), '老周,旧皮箱,胡二爷', '@绑定按资产名最长匹配');
  const u = checkAtRefs('@张三不存在-站着', assets).unknown;
  eq(u.length, 1, '不在资产库的 @ 记入未知');
  ok(u[0].startsWith('张三'), '未知引用带原文');
  eq(checkAtRefs('', assets).known.length, 0, '空文本无引用');
}

/* ---------------- computeStats ---------------- */

const stats = computeStats(FIXTURE, SCRIPT);
eq(stats.totals.segments, 10, '样例十段');
eq(stats.totals.cuts, 34, '样例三十四个镜');
eq(stats.totals.seconds, 119, '总秒数');
eq(stats.totals.targetSeconds, 120, '目标秒数');
ok(stats.totals.avgCutSeconds >= 3 && stats.totals.avgCutSeconds <= 4, '平均一镜 3 秒左右——短剧节奏');
eq(stats.batches.length, 2, '两个生成批次（S02 浓雾清晨 / S01 晨雾）');
ok(stats.batches[0].segments.length + stats.batches[1].segments.length === 10, '批次覆盖全部段');
eq(stats.dialogue.length, 19, '第 1 集 19 句台词全部对到段和镜');
ok(stats.dialogue.every((d) => /^E01-\d{2}$/.test(d.segment) && d.cut >= 1), '对齐单带段号和镜序');
eq(stats.episodes[0].withLines, 10, '台词段计数——本样例每段都带台词');
eq(paramsOf({}).maxSegmentSeconds, DEFAULT_PARAMS.maxSegmentSeconds, '默认段上限 15 秒');
eq(paramsOf({}).maxShotSeconds, DEFAULT_PARAMS.maxShotSeconds, '默认镜上限 6 秒');
eq(paramsOf({}).minShotSeconds, DEFAULT_PARAMS.minShotSeconds, '默认镜下限 1 秒');
eq(paramsOf({ params: { maxShotSeconds: 4 } }).maxShotSeconds, 4, '镜上限可调');

/* ---------------- 质量门：全绿基线 ---------------- */

{
  const gates = gateReport(FIXTURE, CTX);
  ok(gates.every((g) => g.ok), '样例带全部上游全部门通过');
  eq(gates.length, 19, '十八道硬门 + shot-recipe 可选');
}
{
  const gates = gateReport(FIXTURE, {});
  ok(gates.every((g) => g.ok), '不带上游也通过（对账门跳过）');
  ok(gates.find((g) => g.id === 'coverage').detail.includes('跳过'), '跳过要明说，不静默');
}

/* ---------------- 质量门：逐门击穿 ---------------- */

// coverage — 没人认领 / 重复认领 / 区间不合法 / 整场没分镜 / 顺序倒退
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].shots[3].beats = [5, 5]; // 第 4 拍失去认领
  const g = gate(doc, 'coverage');
  ok(!g.ok, '有节拍没人认领被拦');
  ok(g.detail.includes('没人认领'), '点名到拍');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].shots[3].beats = [3, 5]; // 第 3 拍被两镜认领
  ok(gate(doc, 'coverage').detail.includes('重复认领'), '重复认领点得出镜号');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].shots[0].beats = [1, 99];
  ok(!gate(doc, 'coverage').ok, '节拍区间越界被拦');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments = doc.episodes[0].segments.filter((s) => s.sceneIndex !== 1);
  ok(gate(doc, 'coverage').detail.includes('整场没有分镜'), '整场空白被拦');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[1].sceneIndex = 2; // E01-02 变成场次倒退
  ok(!gate(doc, 'coverage').ok, '场次顺序穿插被拦');
}
// segment-cap
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].shots[0].seconds = 15; // 段总秒数 27
  const g = gate(doc, 'segment-cap');
  ok(!g.ok, '段超 15 秒被拦');
  ok(g.detail.includes('E01-01'), '点名到段');
}
// cut-length
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].shots[0].seconds = 0;
  ok(!gate(doc, 'cut-length').ok, '镜短于 1 秒被拦');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].shots[0].seconds = 7;
  const g = gate(doc, 'cut-length');
  ok(!g.ok, '镜超 6 秒被拦——1–6 秒是硬门');
  ok(g.detail.includes('E01-01#1'), '点名到镜');
}
{
  const doc = clone(FIXTURE);
  doc.params = { maxShotSeconds: 3 };
  ok(!gate(doc, 'cut-length').ok, '上限收紧到 3 秒后原样例不再达标');
}
// dialogue-fit
{
  const doc = clone(FIXTURE);
  const seg = doc.episodes[0].segments.find((s) => s.id === 'E01-05');
  seg.shots[0].seconds = 3; // 该镜台词约 3.45 秒（语速 5.5），装不进 3 秒
  const g = gate(doc, 'dialogue-fit');
  ok(!g.ok, '台词装不进镜被拦');
  ok(g.detail.includes('E01-05#1'), '点名到镜');
}
// ep-duration
{
  const doc = clone(FIXTURE);
  for (const s of doc.episodes[0].segments) for (const c of s.shots) c.seconds = Math.min(6, c.seconds + 2);
  ok(gate(doc, 'ep-duration').detail.includes('超'), '写超总时长被拦');
}
{
  const doc = clone(FIXTURE);
  for (const s of doc.episodes[0].segments) for (const c of s.shots) c.seconds = Math.max(1, c.seconds - 2);
  ok(gate(doc, 'ep-duration').detail.includes('欠'), '写欠总时长被拦');
}
// crowd
{
  const doc = clone(FIXTURE);
  const shot = doc.episodes[0].segments.find((s) => s.id === 'E01-09').shots[2];
  shot.characters = ['C01', 'C02', 'C03', 'C04'];
  ok(!gate(doc, 'crowd').ok, '四人同框无拆解说明被拦');
  shot.note = '全景交代后立刻切正反打';
  ok(gate(doc, 'crowd').ok, '带拆解说明就放行');
}
// segment-id
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[3].id = 'E01-99';
  const g = gate(doc, 'segment-id');
  ok(!g.ok, '断号被拦');
  ok(g.detail.includes('E01-04'), '报出应有的段号');
}
// size-phrase
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].shots[0].frame = 'a foggy pier at dawn, cinematic';
  ok(!gate(doc, 'size-phrase').ok, '分镜图提示词缺景别短语被拦');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].shots[0].size = '大远景';
  ok(!gate(doc, 'size-phrase').ok, '景别不在枚举里被拦');
}
// camera-phrase
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].shots[0].camera = '跟拍';
  ok(!gate(doc, 'camera-phrase').ok, '运镜不在 Seedance 词表里被拦');
}
{
  const doc = clone(FIXTURE);
  const shot = doc.episodes[0].segments[0].shots[0]; // camera = Tracking（跟拍）
  shot.shotDesc = shot.shotDesc.replace('跟拍', '机位');
  shot.seedancePrompt = shot.seedancePrompt.replace('跟拍', '机位'); // 提示词是独立字符串，同步去掉
  const g = gate(doc, 'camera-phrase');
  ok(!g.ok, '运镜词没写进自己的视觉描述/提示词被拦');
  ok(g.detail.includes('E01-01#1'), '点名到镜');
}
// shot-duration — 镜号行秒数必须 = seconds 字段
{
  const doc = clone(FIXTURE);
  const shot = doc.episodes[0].segments[0].shots[0];
  shot.seedancePrompt = shot.seedancePrompt.replace('c01,3s', 'c01,4s'); // 秒数改了、提示词没跟着改
  const g = gate(doc, 'shot-duration');
  ok(!g.ok, '镜号行秒数与 seconds 不一致被拦');
  ok(g.detail.includes('c01,3s'), '报出期望的镜号行');
}
// dialogue-lang — 台词逐字进 seedancePrompt
{
  const doc = clone(FIXTURE);
  const seg = doc.episodes[0].segments[0];
  seg.shots[2].seedancePrompt = seg.shots[2].seedancePrompt.replace('上船喽——过河的抓紧，雾要变天。', 'the ferryman calls out.');
  const g = gate(doc, 'dialogue-lang');
  ok(!g.ok, '台词没进 seedancePrompt 被拦');
  ok(g.detail.includes('上船喽'), '点名到缺的台词');
  ok(gate(doc, 'dialogue-lang', {}).detail.includes('跳过'), '没给剧本时本门跳过并明说');
}
// notext — 每镜提示词带无字幕约束
{
  const doc = clone(FIXTURE);
  const shot = doc.episodes[0].segments[0].shots[0];
  shot.seedancePrompt = shot.seedancePrompt.replace('画面不要出现任何文字', '').replace('【不出现任何文字字幕】', '');
  const g = gate(doc, 'notext');
  ok(!g.ok, '提示词缺无字幕约束被拦');
  ok(g.detail.includes('E01-01#1'), '点名到镜');
}
// style-phrase — 头部风格声明统一
{
  const doc = clone(FIXTURE);
  const shot = doc.episodes[0].segments[0].shots[0];
  shot.seedancePrompt = shot.seedancePrompt.replace('写实向半厚涂，画面不要出现任何文字，生成视频无BGM；', '写实向半厚涂；');
  const g = gate(doc, 'style-phrase');
  ok(!g.ok, '提示词头部缺无文字/无BGM 被拦');
}
{
  const doc = clone(FIXTURE);
  const shot = doc.episodes[0].segments[0].shots[0];
  shot.seedancePrompt = shot.seedancePrompt.replace('写实向半厚涂', '油画风格');
  ok(!gate(doc, 'style-phrase').ok, '换掉全片风格声明被拦——同剧画风不许漂');
}
{
  const doc = clone(FIXTURE);
  delete doc.style; // 没有风格声明就没有头部——必须拦
  const g = gate(doc, 'style-phrase');
  ok(!g.ok, '缺顶层 style 被拦');
  ok(g.detail.includes('缺顶层 style'), '报出缺 style');
  ok(validateStoryboard(doc, CTX).some((p) => p.includes('缺少 style')), 'validate 也报缺 style');
}
// shot-ratio — 分镜图比例 = 锁定视频比例（顶层 ratio 存在 + frame 带比例短语）
{
  const doc = clone(FIXTURE);
  delete doc.ratio;
  const g = gate(doc, 'shot-ratio');
  ok(!g.ok, '缺顶层 ratio 被拦');
  ok(g.detail.includes('缺顶层 ratio'), '报出缺 ratio');
}
{
  const doc = clone(FIXTURE);
  doc.ratio = '9:16'; // 样例 frame 都写 16:9，与锁定比例不匹配
  const g = gate(doc, 'shot-ratio');
  ok(!g.ok, 'frame 比例与锁定比例不一致被拦');
  ok(g.detail.includes('9:16'), '报出锁定比例');
}
{
  const doc = clone(FIXTURE);
  doc.ratio = '4:3'; // 只认 9:16 / 16:9
  ok(!gate(doc, 'shot-ratio').ok, '不合法 ratio 被拦');
}
// style 对账：board.style 必须与 cast.json 顶层 style 一致（画风源头在 characters）
{
  const doc = clone(FIXTURE);
  const ctx = { ...CTX, cast: { ...CTX.cast, style: '暗黑写实电影感' } };
  const g = gate(doc, 'style-phrase', ctx);
  ok(!g.ok, 'board.style 与 cast.style 不一致被拦——画风源头在 characters Step 0.5');
  ok(g.detail.includes('不一致'), '报出对账不一致');
}
{
  const doc = clone(FIXTURE);
  doc.style = '暗黑写实电影感'; // 脱离 cast 源头另起炉灶
  ok(!gate(doc, 'style-phrase').ok, '顶层 style 脱离 cast 源头被拦');
}
// prompt-english
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].shots[0].frame = 'extreme wide shot 渡口的浓雾清晨';
  ok(!gate(doc, 'prompt-english').ok, '分镜图提示词混中文被拦');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].shots[0].frame = '  ';
  ok(!gate(doc, 'prompt-english').ok, '空分镜图提示词被拦');
}
// prompt-no-names
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].shots[0].frame += ' 沈知微 standing on the pier';
  ok(!gate(doc, 'prompt-no-names').ok, '分镜图提示词出现角色名被拦');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].shots[1].frame += ' 老伯 squatting'; // cast 里的别名
  ok(!gate(doc, 'prompt-no-names').ok, '角色别名也拦');
}
// bind — @绑定 ∈ 资产库
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].shots[0].pose = '@沈知微-抱着旧皮箱奔跑; @王二麻子-站在路边';
  const g = gate(doc, 'bind');
  ok(!g.ok, '@ 不在资产库被拦');
  ok(g.detail.includes('王二麻子'), '报出未知 @');
  ok(gate(doc, 'bind', { script: SCRIPT }).detail.includes('跳过'), '没给 cast/art 时本门跳过并明说');
}
// refs
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].shots[0].characters = ['C05'];
  ok(!gate(doc, 'refs').ok, '不在该场的人物被拦');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].shots[0].props = ['P02'];
  ok(!gate(doc, 'refs').ok, '不在该场的道具被拦');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].sceneIndex = 9;
  ok(!gate(doc, 'refs').ok, '不存在的场次被拦');
}

/* ---------------- 镜头配方卡库（可选挂载） ---------------- */

{
  const card = parseCardFields(`---
id: demo-card
name: 演示卡
name_en: Demo Card
category: dialogue
cuts: [2, 3]
sizes: [medium, close]
cameras: [Static, Push In]
must_phrases: [over-the-shoulder, blurred foreground shoulder]
---

## 意图

正文一概不读。
`);
  eq(card.id, 'demo-card', '受限解析取到 id');
  eq(card.name_en, 'Demo Card', '英文卡名也是机器字段');
  eq(card.cuts.join(','), '2,3', '行内数组里的整数转成数字');
  eq(card.must_phrases.length, 2, '必备短语按逗号切开');
  eq(card.category, undefined, '门用不到的字段一概不收');
  eq(parseCardFields('没有 frontmatter'), null, '没有 frontmatter 就不是卡片');
  eq(parseCardFields('---\nname: 无 id\n---\n'), null, '没有 id 就不是卡片');
}

const CARDS = loadRecipes(join(here, '../../shot-recipes/references/cards'));
ok(CARDS.size >= 17, '卡片目录读得出全库');
ok(CARDS.get('ots-shot-reverse').must_phrases.includes('over-the-shoulder'), '真实卡片的必备短语读得出来');
eq(CARDS.get('ots-shot-reverse').cuts[0], 2, '真实卡片的格数下限读得出来');
eq(loadRecipes(join(here, '../不存在的目录')).size, 0, '目录不存在不崩');

const SHOTS = { ...CTX, recipes: CARDS };
// 合规引用：两格连排的过肩正反打，必备短语逐条进 frame
const withRecipe = () => {
  const doc = clone(FIXTURE);
  const shots = doc.episodes[0].segments.find((s) => s.id === 'E01-05').shots;
  for (const i of [0, 1]) {
    shots[i].recipe = 'ots-shot-reverse';
    shots[i].frame += ', over-the-shoulder framing with a blurred foreground shoulder';
  }
  return doc;
};

// 跳过条件是「没给 --shots」，不是「没有镜带 recipe」
{
  const g = gate(FIXTURE, 'shot-recipe');
  ok(g.ok, '没挂卡库本门通过');
  ok(g.detail.includes('跳过'), '跳过要明说，不静默');
}
{
  const bare = JSON.parse(JSON.stringify(FIXTURE));
  for (const s of bare.episodes.flatMap((e) => e.segments)) for (const c of s.shots) delete c.recipe;
  const g = gate(bare, 'shot-recipe', SHOTS);
  ok(g.ok, '挂了卡库但全篇没引用配方也算通过');
  eq(g.detail, '本批分镜没有引用配方', '没引用同样明说，不静默');
}
{
  const refs = FIXTURE.episodes.flatMap((e) => e.segments).flatMap((s) => s.shots).filter((c) => c.recipe);
  eq(refs.length, 2, '夹具有两处真实配方引用（hands-tell / insert-beat）');
  const g = gate(FIXTURE, 'shot-recipe', SHOTS);
  ok(g.ok, '夹具的配方引用全过');
  eq(g.detail, '', '全过不留备注');
}
{
  const g = gate(withRecipe(), 'shot-recipe', SHOTS);
  ok(g.ok, '合规引用全过');
  eq(g.detail, '', '全过不留备注');
}
// 击穿一：id 不在卡库
{
  const doc = withRecipe();
  doc.episodes[0].segments.find((s) => s.id === 'E01-05').shots[0].recipe = 'no-such-card';
  const g = gate(doc, 'shot-recipe', SHOTS);
  ok(!g.ok, '引用不存在的配方被拦');
  ok(g.detail.includes('E01-05#1') && g.detail.includes('不在配方库里'), '点名到段号#镜序');
}
// 击穿二：必备短语没进 frame
{
  const doc = withRecipe();
  const shots = doc.episodes[0].segments.find((s) => s.id === 'E01-05').shots;
  shots[1].frame = shots[1].frame.replace('blurred foreground shoulder', 'soft foreground');
  const g = gate(doc, 'shot-recipe', SHOTS);
  ok(!g.ok, '必备短语没进分镜图提示词被拦');
  ok(g.detail.includes('E01-05#2'), '点名到镜');
}
{
  const doc = withRecipe();
  const shots = doc.episodes[0].segments.find((s) => s.id === 'E01-05').shots;
  shots[0].frame = shots[0].frame.replace('over-the-shoulder', 'Over-The-Shoulder');
  ok(gate(doc, 'shot-recipe', SHOTS).ok, '短语判定两边小写化，大小写不影响');
}
// 击穿三：多格配方的连排长度不够
{
  const doc = withRecipe();
  delete doc.episodes[0].segments.find((s) => s.id === 'E01-05').shots[1].recipe;
  const g = gate(doc, 'shot-recipe', SHOTS);
  ok(!g.ok, '两格配方只挂一格被拦');
  ok(g.detail.includes('E01-05#1') && g.detail.includes('要 2 格连排'), '多格配方靠连续同 recipe 的镜表达');
}
// 建议景别／运镜不设门，只在报告里提示偏离
{
  const doc = withRecipe();
  const shot = doc.episodes[0].segments.find((s) => s.id === 'E01-05').shots[0];
  shot.size = 'extreme-wide';
  ok(gate(doc, 'shot-recipe', SHOTS).ok, '建议景别偏离不设门——配方是语汇不是法条');
  const d = recipeDrift(shot, CARDS.get('ots-shot-reverse'));
  eq(d.sizes.join(' / '), 'medium / close', '偏离时报出建议景别');
  eq(d.cameras.length, 0, '运镜没偏离就不报');
  eq(recipeDrift(shot, null).sizes.length, 0, '没有卡片就没有偏离可言');
}
// recipe 不进结构检查
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].shots[0].recipe = 'no-such-card';
  eq(validateStoryboard(doc, CTX).length, 0, '不挂卡库时 recipe 不进结构检查');
}

/* ---------------- 门失败累积 ---------------- */

{
  const gates = [
    { id: 'cut-length', label: '每个镜 1–6 秒', ok: false, detail: 'E01-01#1 9 秒' },
    { id: 'coverage', label: '节拍全覆盖', ok: true, detail: '' },
    { id: 'segment-cap', label: '每段 ≤ 15 秒', ok: false, detail: 'E01-01 共 21 秒' },
  ];
  const rows = gateLogEntries(gates, { doc: 'x.json', at: 'T0' });
  eq(rows.length, 3, '一次运行记一条 run + 每条失败一行');
  eq(rows[0].kind, 'run', '第一行是运行记录');
  eq(rows[0].gates, 3, 'run 记下这次跑了几道门');
  eq(rows[0].failed, 2, 'run 记下这次挂了几道');
  ok(rows.slice(1).every((r) => r.kind === 'fail'), '其余都是失败记录');
  ok(rows.every((r) => r.at === 'T0' && r.doc === 'x.json'), '时间与文档名逐行带上');
  eq(gateLogEntries([], {}).length, 0, '没有门就不写任何东西');

  const all = ['cut-length', 'coverage', 'segment-cap', 'refs'];
  const sum = summarizeGateLog([...rows, ...gateLogEntries(gates, { doc: 'y.json', at: 'T1' })], all);
  eq(sum.runs, 2, '统计跑过几次');
  eq(sum.cleanRuns, 0, '统计全过几次');
  eq(sum.fails, 4, '统计累计失败条数');
  eq(sum.ranked[0].gate, 'cut-length', '按失败次数排序，最常响的在前');
  eq(sum.ranked[0].count, 2, '同一道门跨运行累加');
  ok(sum.ranked[0].samples.length >= 1, '带上 detail 样本，供人看有没有该设而没设的门');
  eq(sum.silent.join(','), 'coverage,refs', '从没响过的门列出来');
  eq(summarizeGateLog([], all).silent.length, 4, '零日志时所有门都算没响过');
  eq(summarizeGateLog([null, 'x', { kind: 'run', failed: 0 }], all).runs, 1, '坏行跳过不炸');
}
eq(GATE_LOG, '.gates.jsonl', '日志文件名固定');

/* ---------------- exportPack（Seedance 投产包） ---------------- */

{
  const pack = exportFrom(FIXTURE);
  eq(pack.files.length, 35, '三十四镜 prompt-NN.md + 一份 manifest');
  ok(pack.files.some((f) => f.path === 'E01-01/prompt-01.md'), '每镜一个 prompt 文件，与 f 图一一对应');
  const p01 = pack.files.find((f) => f.path === 'E01-01/prompt-01.md');
  ok(p01.content.startsWith('# E01-01 · c01 · 3s 镜'), 'prompt 带段号/镜号/秒数标题');
  ok(p01.content.includes('写实向半厚涂，画面不要出现任何文字'), 'prompt 内是完整 seedancePrompt');
  ok(p01.content.includes('- `images/渡口栈桥-sheet.png`'), '参考图清单含场景图');
  ok(p01.content.includes('- `沈知微`'), '参考图清单含 @绑定角色');
  const m01 = pack.manifest.find((x) => x.segment === 'E01-01' && x.shot === 1);
  eq(m01.seconds, 3, 'manifest 带镜秒数');
  eq(m01.start, 0, 'manifest 带切点');
  eq(m01.prompt, 'E01-01/prompt-01.md', 'manifest 指向 prompt 文件');
  eq(m01.binds.includes('沈知微'), true, 'manifest 带 @绑定清单');
  eq(m01.sceneImage, 'images/渡口栈桥-sheet.png', 'manifest 带场景图');
  eq(m01.missing.join(','), 'E01-01/f1.png', '缺图逐张标注');
  ok(pack.missingTotal > 0, '缺图总数上报');
}
{
  const pack = exportFrom(FIXTURE, { imageExists: () => true, dir: 'out' });
  eq(pack.missingTotal, 0, '图齐了就没有缺图标注');
  ok(pack.files.some((f) => f.path === 'out/manifest.json'), '--out 改导出目录');
  ok(pack.files.some((f) => f.path === 'out/E01-01/prompt-01.md'), '镜文件夹跟着 --out 走');
}
function exportFrom(doc, opts = {}) {
  // 需要 assets 才能解析 @绑定——这里直接用 CTX 的资产
  return exportPack(doc, SCRIPT, { imageExists: () => false, ...opts, assets: assetNames(CTX) });
}

/* ---------------- validateStoryboard 结构检查 ---------------- */

eq(validateStoryboard(FIXTURE, CTX).length, 0, '样例零违规');
ok(validateStoryboard(null).length > 0, 'null 不崩');
ok(validateStoryboard({}).some((p) => p.includes('source')), '缺 source 报出来');
ok(validateStoryboard({ source: 'x', episodes: [] }).some((p) => p.includes('episodes')), '空 episodes 报出来');
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0] = { id: 'E01-01' };
  const problems = validateStoryboard(doc, CTX);
  ok(problems.some((p) => p.includes('sceneIndex')), '缺 sceneIndex 报出来');
  ok(problems.some((p) => p.includes('没有分镜')), '缺 shots 报出来');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].shots[0] = { beats: [1, 1] };
  const problems = validateStoryboard(doc, CTX);
  ok(problems.some((p) => p.includes('seconds')), '镜缺秒数报出来');
  ok(problems.some((p) => p.includes('frame')), '镜缺分镜图提示词报出来');
  ok(problems.some((p) => p.includes('space')), '镜缺元数据 space 报出来');
  ok(problems.some((p) => p.includes('seedancePrompt')), '镜缺 seedancePrompt 报出来');
}
{
  const doc = clone(FIXTURE);
  doc.episodes.push(clone(doc.episodes[0]));
  ok(validateStoryboard(doc, CTX).some((p) => p.includes('重复')), '重复集号报出来');
}

/* ---------------- seed ---------------- */

const seeded = seedFromScript(SCRIPT);
eq(seeded.source, '渡口', 'seed 带剧名');
eq(seeded.episodes.length, 6, 'seed 全六集');
eq(seeded.episodes[0].segments.length, 0, 'segments 留空给模型切');
eq(seeded.episodes[0].seedScenes.length, 2, '工作底稿带两场');
eq(seeded.episodes[0].seedScenes[0].beats.length, 13, '底稿带全部节拍');
ok(seeded.episodes[0].seedScenes[0].beats[0].seconds > 0, '每拍带秒数');
eq(seedFromScript(SCRIPT, [2, 3]).episodes.map((e) => e.ep).join(','), '2,3', '--eps 区间过滤');
eq(seedFromScript({}).episodes.length, 0, '空剧本不崩');
eq(seedFromScript(SCRIPT, null, '9:16').ratio, '9:16', 'seed 带出锁定比例（源头固化）');
ok(!('ratio' in seedFromScript(SCRIPT)), '没给比例不带 ratio 字段');

/* ---------------- slug / 枚举 ---------------- */

eq(slug('渡口'), '渡口', '中文原样');
eq(slug('  '), 'storyboard', '空名兜底');
ok(Object.values(SHOT_SIZES).every((s) => s.zh && s.phrase), '景别枚举带中文名与英文短语');
ok(Object.keys(CAMERA_MOVES).length >= 12, 'Seedance 运镜词表覆盖全部动作类型');
ok(CAMERA_MOVES['Static'] === '固定' && CAMERA_MOVES['Push In'] === '推', '运镜词表中英对照');
ok(!('Static Shot' in CAMERA_MOVES), '旧的 H3 词表已退役');

/* ---------------- render markdown ---------------- */

const md = renderMarkdown(FIXTURE, CTX);
ok(md.includes('# 渡口 · 分镜（第 1 集）'), 'md 标题');
ok(md.includes('### E01-01 · 渡口栈桥（浓雾清晨） · 15 秒 · 4 个镜'), 'md 段头带场景名、光照、时长、镜数');
ok(md.includes('Seedance 提示词（每镜一条）'), 'md 带每镜 seedancePrompt 小节');
ok(md.includes('c01,3s,(空间:浓雾河岸土路)'), '镜号行原样进 md');
ok(md.includes('| 元数据 |'), 'md 镜表带元数据列');
ok(md.includes('老周'), 'md 说话人显示名字');
ok(md.includes('生成批次单') && md.includes('配音对齐单'), 'md 带两张工单');
ok(renderMarkdown(FIXTURE, { script: SCRIPT }).includes('C03'), '不给 outline 退回裸 ID');

/* ---------------- render html ---------------- */

const html = renderHtml(FIXTURE, CTX);
ok(html.includes('<!doctype html>'), 'html 完整文档');
ok(!/src="http|href="http|@import|url\(http/.test(html), '零外部资源');
ok(html.includes('镜头节奏带'), '01 镜头节奏带');
ok(html.includes('分集分镜表'), '02 分集分镜表');
ok(html.includes('生成批次单'), '03 生成批次单');
ok(html.includes('配音对齐单'), '04 配音对齐单');
ok(html.includes('✓ 质量门 19 / 19'), '页眉徽章全绿');
ok(html.includes('class="rseg"'), '节奏带按段分组（粗分隔）');
ok(html.includes('#seg-E01-01'), '节奏带段可跳转');
ok(html.includes('主分镜图 · #1 未生成'), '主分镜图缺图时显示占位不装有');
ok(html.includes('Seedance 提示词（每镜一条）'), '每镜提示词面板');
ok(html.includes('class="chip meta"'), '元数据四件套 chips');
ok(html.includes('c01'), '镜号行进报告');
ok(html.includes('class="duo"'), '分镜列表与提示词面板五五分栏');
ok(html.includes('写实向半厚涂，画面不要出现任何文字'), 'seedancePrompt 正文进面板');
ok(html.includes('分镜图提示词'), '每个镜带分镜图提示词复制按钮');
ok(html.includes('id="lightbox"'), '点图放大');
ok(html.includes('渡口-storyboard.json'), '导出文件名');
ok(html.includes('批次 01'), '批次卡编号');
ok(html.includes('@media print'), '打印样式');
ok(html.includes('老周'), 'html 里 ID 换成名字');
// @绑定图：有设定图才嵌（不猜不骗）
{
  const withImgs = renderHtml(FIXTURE, { ...CTX, imageExists: (rel) => rel.startsWith('images/') });
  ok(withImgs.includes('class="cut-binds"'), '有设定图时 @绑定图区出现');
  ok(withImgs.includes('images/老周-sheet.png'), '@绑定图指向设定图路径');
  const noImgs = renderHtml(FIXTURE, CTX);
  ok(!noImgs.includes('class="cut-binds"'), '没有设定图时不显示绑定图区');
}
{
  const withFrame = renderHtml(FIXTURE, { ...CTX, imageExists: () => true });
  ok(withFrame.includes('"E01-01/f1.png"'), '分镜图从段文件夹读');
  ok(!withFrame.includes('未生成'), '有图时不再显示占位');
  ok(withFrame.includes('class="subs"'), '图出全时保留子分镜条');
}
// 分镜图版式跟随源头比例（report 排版 = board.ratio）
{
  ok(html.includes('aspect-ratio:16 / 9'), '16:9 的 board → 横卡 aspect（占满不限宽）');
  ok(!html.includes('max-width:420px'), '横卡不限宽');
}
{
  const doc = { ...clone(FIXTURE), ratio: '9:16' };
  const h = renderHtml(doc, CTX);
  ok(h.includes('aspect-ratio:9 / 16'), '9:16 的 board → 竖卡 aspect');
  ok(h.includes('max-width:420px'), '竖卡限宽居中（防超高）');
}
{
  const doc = clone(FIXTURE); delete doc.ratio;
  const h = renderHtml(doc, CTX);
  ok(!h.includes('aspect-ratio:9 / 16') && !h.includes('aspect-ratio:16 / 9'), '无 ratio → 不锁分镜图 aspect');
  ok(h.includes('object-fit:contain'), '无 ratio → contain 兜底（任何比例完整显示）');
}
// 病灶横幅
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].shots[0].seconds = 7;
  const h = renderHtml(doc, CTX);
  ok(h.includes('class="galert"'), '有门未过时页顶挂病灶横幅');
  ok(h.includes('gatepill fail'), '徽章翻红');
}
// XSS：模型数据全部过 esc
{
  const doc = clone(FIXTURE);
  doc.source = '<script>alert(1)</script>';
  doc.episodes[0].segments[0].note = '<img src=x onerror=alert(1)>';
  const h = renderHtml(doc, { script: SCRIPT });
  ok(!h.includes('<script>alert(1)</script>'), '标题被转义');
  ok(!h.includes('<img src=x'), 'note 被转义');
  ok(h.includes('\\u003c'), '内嵌 JSON 的 < 转成 \\u003c，防 </script 截断');
}

/* ---------------- 报告界面语言（--lang，与 seedancePrompt 独立） ---------------- */

{
  const en = renderHtml(FIXTURE, { ...CTX, lang: 'en' });
  ok(en.includes('<html lang="en">'), 'en 报告的 html lang 属性跟着语言走');
  ok(en.includes('Export JSON'), 'en 界面：导出按钮英文');
  ok(en.includes('Quality gates 19 / 19'), 'en 界面：页眉徽章英文');
  ok(en.includes('Shot rhythm strip'), 'en 界面：节奏带节标题英文');
  ok(en.includes('Segment cards'), 'en 界面：分镜表节标题英文');
  ok(en.includes('Generation batches'), 'en 界面：批次节标题英文');
  ok(en.includes('Audio alignment'), 'en 界面：配音对齐节标题英文');
  ok(en.includes('master frame'), 'en 界面：主分镜图占位标签英文');
  ok(!en.includes('导出 JSON'), 'en 界面不残留中文导出按钮');
  ok(!en.includes('生成批次单'), 'en 界面不残留中文批次标题');
  ok(en.includes('写实向半厚涂，画面不要出现任何文字'), 'en 界面下 seedancePrompt 数据原样不动');
}
{
  const enMd = renderMarkdown(FIXTURE, { ...CTX, lang: 'en' });
  ok(enMd.includes('# 渡口 · Storyboard (Episode 1)') && enMd.includes('Audio alignment'), 'en markdown 标题与节标题英文');
}
{
  const zhAgain = renderHtml(FIXTURE, CTX);
  ok(zhAgain.includes('<html lang="zh">') && zhAgain.includes('导出 JSON'), '默认仍是中文界面');
}
{
  const doc = clone(FIXTURE);
  doc.lang = 'en';
  ok(renderHtml(doc, CTX).includes('Export JSON'), 'JSON 顶层 lang 字段可选定界面语言');
  ok(renderHtml(doc, { ...CTX, lang: 'zh' }).includes('导出 JSON'), 'ctx.lang（--lang）优先于 JSON 的 lang 字段');
}
{
  let threw = false;
  try {
    renderHtml(FIXTURE, { ...CTX, lang: 'ja' });
  } catch (e) {
    threw = /zh \/ en/.test(e.message);
  }
  ok(threw, '非法界面语言抛错并点名内置 zh / en');
}

// 质量门面板是报告的一部分：英文界面下门标签也要翻译
{
  const gateEn = renderHtml(FIXTURE, { ...CTX, lang: 'en' });
  ok(gateEn.includes('Every shot 1–6s'), 'EN 报告的质量门标签翻译且阈值原样保留');
  ok(!gateEn.includes('每个镜 1–6 秒'), 'EN 报告不再出现中文门标签');
  ok(gateEn.includes('no recipe card library mounted'), 'EN 报告的跳过说明也翻译');
}

/* ---------------- 报告里的「配方」列（偏离只提示，不设门） ---------------- */

{
  const doc = withRecipe();
  const rmd = renderMarkdown(doc, SHOTS);
  ok(rmd.includes('| 配方 |'), 'md 镜表有配方列');
  ok(rmd.includes('| 过肩正反打 |'), 'md 显示卡名，没偏离就不带 ≠');
  ok(renderMarkdown(doc, { ...SHOTS, lang: 'en' }).includes('| Recipe |'), 'en md 的配方列表头英文');
  const rhtml = renderHtml(doc, SHOTS);
  ok(rhtml.includes('class="cut-rc">过肩正反打</span>'), 'html 镜行有配方标签');
  ok(!rhtml.includes('≠'), '没偏离就不出 ≠ 上标');
}
{
  const doc = withRecipe();
  doc.episodes[0].segments.find((s) => s.id === 'E01-05').shots[0].size = 'extreme-wide';
  const rhtml = renderHtml(doc, SHOTS);
  ok(rhtml.includes('<sup title="配方建议景别 medium / close——只提示不设门">≠</sup>'), '偏离加 ≠ 上标，建议值写进 title');
  ok(renderMarkdown(doc, SHOTS).includes('过肩正反打 ≠（配方建议景别 medium / close——只提示不设门）'), 'md 没有 title，建议值直接写进格子');
  ok(renderHtml(doc, { ...SHOTS, lang: 'en' }).includes('Recipe suggests size medium / close — advisory, not gated'), 'en 报告的偏离提示英文');
  ok(gate(doc, 'shot-recipe', SHOTS).ok, '偏离在报告里提示，但门照过——门的信用比数量重要');
}
{
  const doc = withRecipe();
  ok(renderMarkdown(doc, CTX).includes('| ots-shot-reverse |'), '不挂卡库时配方列退回裸 id');
  ok(renderMarkdown(FIXTURE, CTX).includes('| — |'), '没引用配方的镜在配方列写 —');
}
console.log(`✓ ${passed} 项自测全部通过`);
