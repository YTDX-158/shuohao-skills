#!/usr/bin/env node
// 自测：覆盖 novel-assets.mjs 的确定性逻辑（任务文本生成 + 绑定解析 + 命名）。
// 不调用任何模型，不花额度，跑一次 < 1 秒。
//   node scripts/selftest.mjs

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  slug,
  buildCastLookup,
  buildArtLookup,
  resolveBinds,
  buildSetupTask,
  buildStoryboardTask,
  placeImages,
} from './novel-assets.mjs';

const here = dirname(fileURLToPath(import.meta.url));

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed++;
}
function eq(actual, expected, msg) {
  assert.equal(actual, expected, msg);
  passed++;
}
function hits(text, pattern, msg) {
  ok(new RegExp(pattern).test(text), msg);
}

// ---- 夹具：最小 cast / art / storyboard ----
const CAST = {
  characters: [
    {
      name: '林风',
      aliases: ['小风'],
      image: { sheet: 'ONE 16:9 landscape canvas. LEFT ZONE bust portrait of 林风.' },
    },
    {
      name: '裂口女',
      aliases: [],
      image: { sheet: 'ONE 16:9 landscape canvas. LEFT ZONE bust of 裂口女.' },
    },
  ],
};
const ART = {
  scenes: [
    { id: 'S01', name: '教室', image: { sheet: 'ONE 16:9 landscape canvas master view of 教室.' } },
  ],
  props: [
    { id: 'P01', name: '蝴蝶结', image: { sheet: 'ONE 16:9 canvas, white background, 蝴蝶结.' } },
  ],
};
const SB = {
  style: '暗黑写实电影感',
  episodes: [
    {
      ep: 1,
      segments: [
        {
          id: 'E01-01',
          shots: [
            {
              size: 'close-up',
              camera: 'Static',
              sceneImage: 'images/教室-sheet.png',
              binds: ['林风', '小风', '蝴蝶结', '不存在的角色'],
              frame: 'static close-up of 林风 holding 蝴蝶结 in 教室',
            },
            {
              size: 'wide',
              camera: 'Push In',
              sceneImage: 'images/教室-sheet.png',
              binds: ['裂口女'],
              frame: 'push-in wide of 裂口女 entering 教室',
            },
          ],
        },
        {
          id: 'E01-02',
          shots: [
            {
              size: 'close-up',
              camera: 'Static',
              sceneImage: 'images/教室-sheet.png',
              binds: ['林风'],
              frame: 'static close-up of 林风 reacting',
            },
          ],
        },
      ],
    },
  ],
};

// ---- slug ----
eq(slug('林风'), '林风', 'slug 保留中文');
eq(slug('柳城御诡师学院教室'), '柳城御诡师学院教室', 'slug 长中文名');
eq(slug('a b/c:d'), 'a-b-c-d', 'slug 非法字符转 -');

// ---- buildCastLookup ----
const lookup = buildCastLookup(CAST);
ok(lookup.has('林风'), 'lookup 含正式名');
ok(lookup.has('小风'), 'lookup 含别名');
eq(lookup.get('小风'), '林风', '别名映射到正式名');

// ---- buildArtLookup ----
const artNames = buildArtLookup(ART);
ok(artNames.has('教室'), 'artNames 含场景');
ok(artNames.has('蝴蝶结'), 'artNames 含道具');

// ---- resolveBinds ----
const r1 = resolveBinds(['林风', '蝴蝶结'], lookup, artNames);
eq(r1.length, 2, '正式名 + 道具名都解析');
ok(r1.includes('林风'), '林风解析出');
ok(r1.includes('蝴蝶结'), '蝴蝶结解析出');

const r2 = resolveBinds(['小风'], lookup, artNames);
ok(r2.includes('林风'), '别名 小风 → 正式名 林风');

const r3 = resolveBinds(['不存在的角色'], lookup, artNames);
eq(r3.length, 0, '解析不出的不输出（不阻断）');

const r4 = resolveBinds(['@裂口女-低头'], lookup, artNames);
ok(r4.includes('裂口女'), '@前缀和-动作后缀都能剥');

// ---- buildSetupTask ----
const setup = buildSetupTask({ name: '测试剧', cast: CAST, art: ART, ratio: '9:16', style: '写实' });
hits(setup, '一次性生成全部 4 张设定图', '设定图数量 = 角色2+场景1+道具1 = 4');
hits(setup, '【图1 · 林风】', '图1 林风标题');
hits(setup, '命名：林风-sheet.png', '林风命名');
hits(setup, '提示词：ONE 16:9 landscape canvas', '林风 sheet 提示词原样');
hits(setup, '统一画风「写实」', '风格锚点写入');
hits(setup, '蝴蝶结-sheet.png', '道具命名');
hits(setup, '记住这些设定图', '设定图强调记住形象供分镜引用');
eq(/设定图\.zip/.test(setup), false, '设定图不单独打包（统一由说明.txt 指挥交付）');
// 设定图任务不应写死 9:16 全局比例（会跟 sheet 内部 16:9 打架）
eq(/统一比例 9:16/.test(setup), false, '设定图任务不写全局比例');

// ---- 缺 image.sheet 的项要跳过，不产 undefined（防回归漏洞5）----
const castNoSheet = {
  characters: [
    { name: '有sheet', image: { sheet: 'good sheet' } },
    { name: '没sheet', image: {} },
    { name: '空sheet', image: { sheet: '   ' } },
  ],
};
const setupFiltered = buildSetupTask({ name: 'T', cast: castNoSheet, art: { scenes: [], props: [] }, ratio: '9:16', style: 's' });
eq(/一次性生成全部 1 张设定图/.test(setupFiltered), true, '缺 sheet 的项被过滤，数量=1');
eq(/提示词：undefined/.test(setupFiltered), false, '不输出 undefined');
ok(!setupFiltered.includes('没sheet') && !setupFiltered.includes('空sheet'), '缺 sheet 的项不出现在任务文本');

// ---- buildStoryboardTask ----
const story = buildStoryboardTask({
  name: '测试剧', storyboard: SB, cast: CAST, art: ART, ratio: '9:16', style: '写实',
  castLookup: lookup, artNames,
});
hits(story, '生成全部 3 张分镜图', '分镜图数量（E01-01 2镜 + E01-02 1镜）');
hits(story, '统一比例 9:16（竖屏）', '分镜图比例写死（9:16 → 竖屏方向）');
hits(story, '引用你上面生成的设定图', '分镜图记忆引用（不再要求用户上传）');

// ---- 比例方向推导（防回归：16:9 不能写"竖屏"，未知比例不带方向词）----
const storyLand = buildStoryboardTask({
  name: '测试剧', storyboard: SB, cast: CAST, art: ART, ratio: '16:9', style: '写实',
  castLookup: lookup, artNames,
});
hits(storyLand, '统一比例 16:9（横屏）', '16:9 → 横屏方向（防写死"竖屏"回归）');
eq(/竖屏/.test(storyLand), false, '16:9 分镜任务不含"竖屏"');
const storyUnknown = buildStoryboardTask({
  name: '测试剧', storyboard: SB, cast: CAST, art: ART, ratio: '1:1', style: '写实',
  castLookup: lookup, artNames,
});
hits(storyUnknown, '统一比例 1:1，统一画风', '未知比例不带方向词（1:1 不是竖也不是横）');
eq(/竖屏|横屏/.test(storyUnknown), false, '未知比例无方向词');
eq(/参考图清单/.test(story), false, '无参考图清单段（上传方式已废弃）');
eq(/发这段文本之前/.test(story), false, '无给用户的上传指引（GPT 自足）');
hits(story, '【E01-01 第01镜】', '逐镜标题');
hits(story, '命名：E01-01_f1.png', '扁平命名（无前导零，与上游 f${i+1}.png 对账）');
hits(story, '命名：E01-02_f1.png', '第二段镜号从 f1 重新开始（段内计数，防全局累计错位）');
eq(/E01-02_f2\.png/.test(story), false, '第二段不是 f2（全局累计 bug 的回归防护）');
eq(/E01-01_f0\d\.png/.test(story), false, '分镜图命名不带前导零（防回归漏洞1）');
hits(story, '引用设定图：【教室】【林风】【蝴蝶结】', '引用设定图前缀（去重别名）');
hits(story, 'static close-up of 林风', 'frame 提示词原样');
eq(/分镜图\.zip/.test(story), false, '分镜图不单独打包（统一由说明.txt 指挥交付）');

// ---- buildInstruction + packZip 结构 ----
const { buildInstruction } = await import('./novel-assets.mjs');
const instr = buildInstruction({ name: '测试剧', shotCount: 36, sheetCount: 16, ratio: '9:16', style: '写实' });
hits(instr, '第 1 步：生成全部设定图', '说明.txt 第1步');
hits(instr, '第 2 步：生成全部分镜图', '说明.txt 第2步');
hits(instr, '第 3 步：打包交付', '说明.txt 第3步');
hits(instr, '生成全部 16 张设定图', '说明.txt 设定图数量');
hits(instr, '生成全部 36 张分镜图', '说明.txt 分镜图数量');
hits(instr, '记住', '说明.txt 强调记住形象');
eq(/style-ref\.png/.test(instr), false, '无样张图时说明.txt 不提样张');
eq(/全局避免/.test(instr), false, '无负面词时说明.txt 不提负面词');

// ---- buildInstruction：样张图 + 负面词（防回归，v7.1 前置询问落地）----
const instrRef = buildInstruction({ name: '测试剧', shotCount: 36, sheetCount: 16, ratio: '9:16', style: '写实', styleRef: true, negative: 'avoid anime, cel shading' });
hits(instrRef, 'style-ref.png', '有样张图时说明.txt 提到样张文件');
hits(instrRef, '参考样张', '说明.txt 写明样张=画风锚');
hits(instrRef, '不要照搬样张里的人物', '说明.txt 防抄长相（只参考画风）');
hits(instrRef, '全局避免：avoid anime, cel shading', '负面词写进说明.txt（GPT 网页版无负面词栏）');
hits(instrRef, '所有 sheet 提示词已包含本剧画风', '说明.txt 说明画风由 sheet 源头带（职责分工：不在说明.txt 重复配方）');

// ---- placeImages（扩展名支持，防回归漏洞4）----
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
const tmp = mkdtempSync(join(tmpdir(), 'novel-assets-test-'));
const srcTmp = join(tmp, 'src');
mkdirSync(srcTmp, { recursive: true });
writeFileSync(join(srcTmp, '林风-sheet.jpg'), 'j');   // 设定图 jpg
writeFileSync(join(srcTmp, '教室-sheet.webp'), 'w');  // 设定图 webp
writeFileSync(join(srcTmp, 'E01-01_f1.jpg'), 'f');    // 分镜图 jpg
const outTmp = join(tmp, 'out');
const moved = placeImages(srcTmp, outTmp);
eq(moved.sheets, 2, 'place 归位 2 张设定图（jpg/webp）');
eq(moved.frames, 1, 'place 归位 1 张分镜图（jpg）');
ok(existsSync(join(outTmp, 'images', '林风-sheet.png')), 'jpg 设定图转存为 .png');
ok(existsSync(join(outTmp, 'images', '教室-sheet.png')), 'webp 设定图转存为 .png');
ok(existsSync(join(outTmp, 'E01-01', 'f1.png')), 'jpg 分镜图转存为 f1.png');
rmSync(tmp, { recursive: true, force: true });

// ---- render 无参数应报错退出（防回归）----
import { spawnSync } from 'node:child_process';
const renderNoArg = spawnSync(process.execPath, [join(here, 'novel-assets.mjs'), 'render'], { encoding: 'utf8' });
eq(renderNoArg.status, 1, 'render 无参数退出码为 1');
ok(/至少一个 --cast-script/.test(renderNoArg.stderr), 'render 无参数提示缺 script');

// ---- 全部通过 ----
console.log(`✅ selftest 全部通过：${passed} 项`);
