#!/usr/bin/env node
/**
 * novel-assets.mjs — novel-assets skill 的确定性工具（出图闭环）
 *
 * 把五段管线产出的提示词打包成「出图包 zip」（发 GPT 用），图回来归位，report 补图。
 * 三个命令：
 *
 *   run <剧名> --cast <cast.json> --art <art.json> --storyboard <storyboard.json>
 *       生成 <剧名>-出图包.zip：说明.txt（GPT 总指令）+ 01_设定图提示词.txt + 02_分镜图提示词.txt
 *       用户把 zip 整个发给 GPT，GPT 自己按说明.txt 完成全部步骤（设定图→记住→分镜图→打包）
 *       [--ratio 9:16]     视频/分镜图比例（默认取 storyboard.json 顶层 ratio，再兜底 9:16；分镜图任务写入比例+方向词 竖屏/横屏）
 *       [--style "暗黑写实电影感"]   全局风格锚点（默认取 storyboard.style）
 *       [--style-ref <图>] 样张图本地路径（飞书特化风格用）→ 打包进 zip 为 style-ref.png，
 *                          说明.txt 写"参考画风不参考长相"；画风由 sheet 源头带，样张只在设定图阶段用一次
 *       [--negative "avoid ..."] 负面词（GPT 网页版无负面词栏，转成"避免"写进说明.txt）
 *       [--out .]          输出目录（默认当前目录）
 *       依赖 python（zipfile，UTF-8 文件名标志防中文乱码）
 *
 *   place <zip解压目录> --out <输出目录>
 *       把 GPT 打包回来的图归位：设定图 → images/<名>-sheet.png，
 *       分镜图 E01-xx_fN.png → <输出目录>/<段号>/f<切序>.png
 *       核对文件名，防错位；找不到匹配的图会打印警告但不阻断。
 *
 *   render --cast <cast.json> --art <art.json> --storyboard <storyboard.json>
 *       图归位后补 report：转发调用各 skill 的 render 命令，捕获 HTML 自动落盘
 *       为 cast-report.html / art-report.html / storyboard-report.html。
 *       需要各 skill 的脚本路径（--cast-script / --art-script / --sb-script），
 *       缺哪个就跳过哪个，只补图已归位的那几个。
 *
 * 零依赖，node >= 18 标准库。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, copyFileSync, unlinkSync } from 'fs';
import { resolve, dirname, basename, join } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

function flag(rest, name, fallback = null) {
  const i = rest.indexOf(name);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : fallback;
}

/** 比例 → 方向描述（9:16 竖屏 / 16:9 横屏；其他比例不带方向词） */
function ratioOrientation(ratio) {
  const r = String(ratio).trim();
  if (r === '9:16') return '竖屏';
  if (r === '16:9') return '横屏';
  return '';
}

/** 名字 → 安全文件名（与各 skill 的 slug 一致：中文保留，非法字符转 -） */
function slug(name) {
  return String(name)
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** 收集 cast 的角色名 + 别名 → 正式名 的映射，方便 binds 里遇到别名兜底 */
function buildCastLookup(cast) {
  const map = new Map();
  const list = cast?.characters ?? cast ?? [];
  for (const c of list) {
    map.set(c.name, c.name);
    for (const a of c.aliases ?? []) map.set(a, c.name);
  }
  return map;
}

/** 收集 art 的场景名 + 道具名 */
function buildArtLookup(art) {
  const names = new Set();
  for (const s of art?.scenes ?? []) names.add(s.name);
  for (const p of art?.props ?? []) names.add(p.name);
  return names;
}

/** 给定 storyboard 的 binds（可能含别名/动作后缀），解析出「资产正式名」列表 */
function resolveBinds(binds, castLookup, artNames) {
  const out = [];
  for (const raw of binds ?? []) {
    // 剥 @ 前缀
    let name = String(raw).trim().replace(/^@/, '');
    // 剥「-动作」后缀（如 @林风-低头）——但别把带-的名字拆坏，先查全名，再试拆
    // 角色命中：push 归一后的正式名（别名也归到正式名）
    if (castLookup.has(name)) { out.push(castLookup.get(name)); continue; }
    if (artNames.has(name)) { out.push(name); continue; }
    // 试拆 - 前缀段
    const head = name.split('-')[0].trim();
    const resolved = castLookup.get(head) ?? (artNames.has(head) ? head : null);
    if (resolved) out.push(resolved);
    // 拆不出就不输出（放警告，让调用方决定）
  }
  return [...new Set(out)];
}

/* ------------------------------------------------------------------ */
/* 任务文本模板                                                         */
/* ------------------------------------------------------------------ */

/** 设定图任务文本：指令 + 规范 + 打包要求 + 逐张提示词 */
function buildSetupTask({ name: title, cast, art, ratio, style }) {
  const lines = [];
  const chars = cast?.characters ?? cast ?? [];
  const scenes = art?.scenes ?? [];
  const props = art?.props ?? [];

  // 过滤出有 sheet 提示词的项：空 sheet 跳过（产 undefined 会得废图），
  // 但要在脚本里提醒，不能静默。
  const withSheet = (list) => list.filter((x) => x?.image?.sheet?.trim());
  const charOk = withSheet(chars);
  const sceneOk = withSheet(scenes);
  const propOk = withSheet(props);
  const skipped =
    (chars.length - charOk.length) + (scenes.length - sceneOk.length) + (props.length - propOk.length);
  if (skipped > 0) {
    console.warn(`⚠️ 设定图任务跳过 ${skipped} 项（缺 image.sheet 提示词，不产废图）`);
  }

  lines.push(`你是一名美术总监，为短剧《${title}》一次性生成全部 ${charOk.length + sceneOk.length + propOk.length} 张设定图。`);
  lines.push('');
  lines.push('【统一要求】');
  lines.push(`1. 所有图统一画风「${style}」，同一世界观，同一角色跨图长相一致。比例按每张提示词内的版面要求（设定图为资产图，含多视角+细节特写）。`);
  lines.push('2. 每张图是一张标准设定图/资产图：包含多视角 + 细节特写（见每张提示词的具体版面要求）。');
  lines.push('3. 依次生成，每张都要记住已生成的角色设定，保证整批画风连贯。');
  lines.push('4. 纯白背景（场景图的背景由提示词决定），画面干净，无文字、无水印、无边框。');
  lines.push('5. 本文件只管生成设定图，先不要打包——等全部分镜图也生成完，说明.txt 会让你统一打包交付。');
  lines.push('');
  lines.push('【重要：记住这些设定图，后面还有用】');
  lines.push('这些设定图是后面分镜图（关键帧）的参考基准。生成时要牢牢记住每一张的');
  lines.push('角色长相、服装、场景环境、道具造型，后面生成分镜图时我会要求你直接引用这些设定图。');
  lines.push('');
  lines.push('【每张图的提示词】');
  lines.push('');

  const dump = (label, sheet, i) => {
    lines.push(`【图${i} · ${label}】`);
    lines.push(`命名：${slug(label)}-sheet.png`);
    lines.push(`提示词：${sheet}`);
    lines.push('');
  };

  let i = 1;
  for (const c of charOk) dump(c.name, c.image.sheet, i++);
  for (const s of sceneOk) dump(s.name, s.image.sheet, i++);
  for (const p of propOk) dump(p.name, p.image.sheet, i++);

  lines.push('以上设定图全部生成完即可，先不要打包，等说明.txt 统一指挥交付。');
  return lines.join('\n');
}

/** 分镜图任务文本：指令 + 参考图清单 + 逐镜绑定 + frame + 打包要求 */
function buildStoryboardTask({ name: title, storyboard, cast, art, ratio, style, castLookup, artNames }) {
  const lines = [];
  const eps = storyboard?.episodes ?? [];
  const segments = eps.flatMap(e => e.segments ?? []);
  const shots = segments.flatMap(sg => (sg.shots ?? []).map(sh => ({ seg: sg.id, ...sh })));

  // 参考来源：GPT 自己刚生成的设定图（记忆引用），不再需要用户上传。
  // 参考绑定格式保持「【角色名】」，GPT 凭记忆对应到上面生成的设定图。
  lines.push(`你是一名美术总监，为短剧《${title}》生成全部 ${shots.length} 张分镜图（关键帧）。`);
  lines.push('');
  lines.push('【统一要求】');
  lines.push(`1. 所有分镜图统一比例 ${ratio}${ratioOrientation(ratio) ? `（${ratioOrientation(ratio)}）` : ''}，统一画风「${style}」，与上面生成的设定图保持同一世界观。`);
  lines.push('2. 每一镜都引用你上面生成的设定图：角色的脸/衣服用对应角色设定图，环境用对应场景设定图，道具用对应道具设定图。');
  lines.push('3. 我已在每镜标注参考，照着引用你刚生成的那张设定图，不要自己另造形象。');
  lines.push('4. 按 E01-01 → E01-11 顺序依次生成，一镜一张，生成完再生成下一镜。');
  lines.push('5. 画面干净，无文字、无水印、无边框。');
  lines.push('');
  lines.push('【每镜提示词】');
  lines.push('');

  // 按段分组，段内镜号从 1 数（与上游 exportPack 的 f${i+1} 一致——i 是段内索引）。
  // 全局累计会让 E01-02 变成 f4.png 而 manifest 期望 f1.png，段内镜号全错位。
  const bySeg = new Map();
  for (const sh of shots) {
    const seg = sh.seg || 'E01-XX';
    if (!bySeg.has(seg)) bySeg.set(seg, []);
    bySeg.get(seg).push(sh);
  }
  let g = 0; // 全局序号，仅标题用（给人看整体进度）
  for (const [seg, segShots] of bySeg) {
    segShots.forEach((sh, i) => {
      g++;
      // 文件名用段内镜号（i+1，无前导零）：与 render/exportPack 的 f${i+1}.png 对账
      const localNo = i + 1;
      const idx = String(g).padStart(2, '0'); // 标题用全局序号（好看）
      const file = `${seg}_f${localNo}.png`;
      // 参考绑定
      const sceneRef = sh.sceneImage
        ? (sh.sceneImage.split('/').pop().replace(/-sheet\.png$/, ''))
        : null;
      const binds = resolveBinds(sh.binds, castLookup, artNames);
      const refs = [sceneRef, ...binds].filter(Boolean);
      const refLabel = refs.length ? refs.map(r => `【${r}】`).join('') : '（无参考图）';

      lines.push(`【${seg} 第${idx}镜】`);
      lines.push(`命名：${file}`);
      lines.push(`引用设定图：${refLabel}`);
      lines.push(`画面：${sh.frame ?? ''}`);
      lines.push('');
    });
  }

  lines.push(`以上 ${shots.length} 张分镜图全部生成完即可，先不要打包，等说明.txt 统一指挥交付。`);
  lines.push('zip 内每张图按我给的命名保存（段号_镜号.png），文件名不要改。');
  return lines.join('\n');
}

/** 说明.txt：给 GPT 的总指令——统一画风 → 设定图 → 记住形象 → 分镜图 → 打包交付 */
function buildInstruction({ name: title, shotCount, sheetCount, ratio, style, styleRef = false, negative = null }) {
  // 样张图（画风锚）：只在设定图阶段用一次，防抄长相
  const styleRefLine = styleRef
    ? '\n- style-ref.png — 本剧画风的参考样张（画风锚点）'
    : '';
  const styleRefSection = styleRef
    ? `\n包内 style-ref.png 是本剧画风的参考样张：生成设定图时参考它的光影、材质、上色质感来统一画风；但角色长相严格按提示词描述，不要照搬样张里的人物。`
    : '';
  // 负面词（GPT 网页版无负面词栏，写成"避免"融进提示词）
  const negativeSection = negative
    ? `\n全局避免：${negative}。`
    : '';
  return `# ${title} · 出图任务（请按顺序完成全部步骤）

你是本剧的美术总监。本包里有三个文件${styleRef ? ' + 一张风格参考样张' : ''}：
- 01_设定图提示词.txt — 全部设定图的提示词（角色/场景/道具）
- 02_分镜图提示词.txt — 全部分镜图（关键帧）的提示词，每镜标注了引用哪张设定图${styleRefLine}

【统一画风】
所有 sheet 提示词已包含本剧画风（同一世界观、同一画风），照画即可。${styleRefSection}${negativeSection}

【第 1 步：生成全部设定图】
读 01_设定图提示词.txt，依次生成全部 ${sheetCount} 张设定图。
每张按文件里给的命名保存（<名>-sheet.png）。生成时牢牢记住每张图的
角色长相、服装、场景环境、道具造型——后面分镜图要直接引用它们。

【第 2 步：生成全部分镜图（关键帧）】
读 02_分镜图提示词.txt，依次生成全部 ${shotCount} 张分镜图。
每一镜都引用你在第 1 步生成的设定图（按"引用设定图"标注选图），
角色的脸/衣服/场景/道具必须和设定图一致，不要另造形象。
所有分镜图统一比例 ${ratio}${ratioOrientation(ratio) ? `（${ratioOrientation(ratio)}）` : ''}，统一画风「${style}」。

【第 3 步：打包交付】
把全部图片（设定图 + 分镜图）打包成一个 zip 压缩文件交付，
zip 内每张图按我给的命名保存，文件名不要改，不要建目录结构（扁平命名）。

【注意事项】
- 一次生成多张，如果中途停下，等我说"继续"后再接着生成下一张，不要从头再来。
- 分镜图一镜一张，画面干净，无文字、无水印、无边框。
`;
}

/** 用 python zipfile 打包（node 无标准库 zip；python 显式标 UTF-8 文件名防乱码） */
function packZip({ title, out, files }) {
  // 文件清单写临时文件（避免命令行参数超长：Windows 上限约 32KB，内容大时撑爆），
  // python 从文件读，用完删。
  const tmpFile = join(out, `.${slug(title)}-pack.json`);
  writeFileSync(tmpFile, JSON.stringify(files), 'utf8');
  const pyCode = `
import zipfile, sys, json, base64
out = sys.argv[1]
entries = json.load(open(sys.argv[2], encoding='utf-8'))
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for e in entries:
        name = e['name']
        # 强制 UTF-8 文件名标志，防中文名乱码
        info = zipfile.ZipInfo(name, date_time=(2026, 8, 23, 0, 0, 0))
        info.flag_bits |= 0x800
        if 'b64' in e:  # 二进制文件（如样张图 style-ref.png）
            z.writestr(info, base64.b64decode(e['b64']))
        else:
            z.writestr(info, e['content'])
print('zip 写入:', out)
`;
  const r = spawnSync('python', ['-c', pyCode, join(out, `${title}-出图包.zip`), tmpFile], { encoding: 'utf8' });
  try { unlinkSync(tmpFile); } catch { /* 临时文件清理失败不影响结果 */ }
  if (r.status !== 0) {
    console.error('❌ zip 打包失败:', r.stderr || r.stdout);
    process.exit(1);
  }
  return join(out, `${title}-出图包.zip`);
}

/** 从 zip 解压目录把图按命名规则归位到输出目录 */
function placeImages(srcDir, outDir) {
  if (!existsSync(srcDir)) {
    console.error(`❌ 解压目录不存在: ${srcDir}`);
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(outDir, 'images'), { recursive: true });

  const moved = { sheets: 0, frames: 0 };
  const warnings = [];

  const walk = (dir) => {
    for (const ent of readdirSync(dir)) {
      const full = join(dir, ent);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(png|jpe?g|webp)$/i.test(ent)) continue;
      // 样张图（style-ref）：参考图非产出，GPT 可能带回交付 zip，不归位、不警告
      if (/^style-ref\.(png|jpe?g|webp)$/i.test(ent)) continue;

      // 设定图：<名>-sheet.png（GPT 可能存 .jpg/.webp，归位统一转 .png 名）
      const sm = ent.match(/^(.*)-sheet\.(png|jpe?g|webp)$/i);
      if (sm) {
        const dest = join(outDir, 'images', `${sm[1]}-sheet.png`);
        copyFileSync(full, dest);
        moved.sheets++;
        continue;
      }
      // 分镜图：E01-01_f1.png（或 f1.png 兜底）
      const m = ent.match(/^(E\d{2}-\d{2})_f(\d+)\.(png|jpe?g|webp)$/i) || ent.match(/^f(\d+)\.(png|jpe?g|webp)$/i);
      if (m) {
        const seg = m[1] || 'unknown';
        const seq = m[2];
        const segDir = join(outDir, seg);
        mkdirSync(segDir, { recursive: true });
        copyFileSync(full, join(segDir, `f${seq}.png`));
        moved.frames++;
        continue;
      }
      warnings.push(`⚠️ 不认识的图: ${ent}（跳过）`);
    }
  };
  walk(srcDir);

  console.log(`✅ 归位完成：设定图 ${moved.sheets} 张 → ${join(outDir, 'images')}/`);
  console.log(`✅ 分镜图 ${moved.frames} 张 → ${outDir}/<段号>/`);
  for (const w of warnings) console.log(w);
  return moved;
}

/* ------------------------------------------------------------------ */
/* render：补 report（转发）                                            */
/* ------------------------------------------------------------------ */

// 转发调用各 skill 的 render 命令并捕获 stdout。
// 各 skill 的 render 把 HTML 打到 stdout（SKILL 里靠用户重定向 `> report.html` 落盘），
// novel-assets 补 report 要自动落盘，所以捕获回来写文件（stderr 保持继承，警告/错误仍显示）
function runScript(scriptPath, args) {
  const r = spawnSync(process.execPath, [scriptPath, ...args], { stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '' };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const USAGE = `novel-assets.mjs — novel-assets skill 的确定性工具（出图闭环）

  run <剧名> --cast <cast.json> --art <art.json> --storyboard <storyboard.json>
        打包成 <剧名>-出图包.zip（发 GPT 用）：说明.txt + 01_设定图提示词.txt + 02_分镜图提示词.txt
        GPT 收包后自己完成全部：设定图→记住形象→分镜图（引用设定图）→打包交付
        [--ratio 9:16]       视频/分镜图比例（默认取 storyboard.json 顶层 ratio，再兜底 9:16）
        [--style "风格"]      全局画风锚点（默认取 storyboard.style）
        [--style-ref <图>]   样张图本地路径 → 入包 style-ref.png（画风锚；说明.txt 防抄长相）
        [--negative "avoid.."]  负面词（写进说明.txt）
        [--out .]            输出目录（默认当前目录）
        依赖 python zipfile（UTF-8 文件名标志防中文乱码）

  place <zip解压目录> --out <输出目录>
        图归位：设定图 → images/<名>-sheet.png，分镜图 E01-xx_fN.png → <段号>/fN.png

  render --cast <cast.json> --art <art.json> --storyboard <storyboard.json>
         [--script <script.json>]    剧本 JSON（storyboard render 必需，否则绑定/台词门误判）
         [--outline <outline.json>]  大纲 JSON（可选，让"提示词禁人名"门生效）
        [--cast-script <novel-characters.mjs>]  [--art-script <novel-art.mjs>]
        [--sb-script <novel-storyboard.mjs>]
         [--out .]                    输出目录（默认当前目录）
        图归位后补 report：转发各 skill 的 render，HTML 自动落盘为
        cast-report.html / art-report.html / storyboard-report.html（缺哪个跳过哪个）

  slug <name>   名字转安全文件名`;

function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'run': {
      const title = rest[0];
      if (!title) { console.error(USAGE); process.exit(1); }
      const cast = flag(rest, '--cast');
      const art = flag(rest, '--art');
      const sbPath = flag(rest, '--storyboard');
      if (!cast || !art || !sbPath) { console.error('❌ run 需要 --cast --art --storyboard 三个 JSON'); process.exit(1); }
      const ratioArg = flag(rest, '--ratio');   // 手动指定优先
      const out = flag(rest, '--out', '.');
      const styleRef = flag(rest, '--style-ref');   // 样张图本地路径（可选，飞书特化风格用）
      const negative = flag(rest, '--negative');    // 负面词（可选，GPT 网页版无负面词栏）

      const castData = readJson(cast);
      const artData = readJson(art);
      const sbData = readJson(sbPath);
      const style = flag(rest, '--style', sbData.style || '写实');
      // 比例源头固化：--ratio 手动优先 → storyboard.json 顶层 ratio（seed 时 --outline 带出）→ 兜底 9:16
      const ratio = String(ratioArg ?? '').trim() || String(sbData?.ratio ?? '').trim() || '9:16';
      // 缺源头字段提醒：独立跑 storyboard（没走 seed --outline）时顶层可能没有 ratio/style，兜底值可能不对
      if (!String(sbData?.ratio ?? '').trim())
        console.warn('⚠️ storyboard.json 无顶层 ratio，兜底 9:16——若项目锁定其他比例，用 --ratio 指定');
      if (!String(sbData?.style ?? '').trim())
        console.warn('⚠️ storyboard.json 无顶层 style，兜底「写实」——确认画风');

      const setupTxt = buildSetupTask({ name: title, cast: castData, art: artData, ratio, style });
      const castLookup = buildCastLookup(castData);
      const artNames = buildArtLookup(artData);
      const storyTxt = buildStoryboardTask({
        name: title, storyboard: sbData, cast: castData, art: artData, ratio, style,
        castLookup, artNames,
      });
      const sheetCount = (setupTxt.match(/【图\d+ ·/g) || []).length;
      const shotCount = (storyTxt.match(/【E\d{2}-\d{2} 第\d+镜】/g) || []).length;

      // 样张图是否真实入包：路径存在才算（否则说明.txt 不能声称包里有样张，GPT 会找空）
      let styleRefPacked = false;
      if (styleRef && existsSync(styleRef)) {
        styleRefPacked = true;
      } else if (styleRef) {
        console.warn(`⚠️ --style-ref 路径不存在: ${styleRef}（样张图不入包，画风可能不锁）`);
      }

      const instructionTxt = buildInstruction({ name: title, shotCount, sheetCount, ratio, style, styleRef: styleRefPacked, negative });

      mkdirSync(out, { recursive: true });
      const files = [
        { name: '说明.txt', content: instructionTxt },
        { name: '01_设定图提示词.txt', content: setupTxt },
        { name: '02_分镜图提示词.txt', content: storyTxt },
      ];
      // 样张图入包：飞书特化风格必须（画风锚，设定图阶段用一次）
      if (styleRefPacked) {
        files.push({ name: 'style-ref.png', b64: readFileSync(styleRef).toString('base64') });
      }
      const zipPath = packZip({ title, out, files });
      console.log(`✅ 出图包 → ${zipPath}`);
      console.log(`   内容：说明.txt + 01_设定图提示词.txt(${sheetCount}张) + 02_分镜图提示词.txt(${shotCount}镜)${styleRefPacked ? ' + style-ref.png' : ''}`);
      console.log(`   比例 ${ratio} · 画风「${style}」${negative ? ` · 负面词「${negative}」` : ''}`);
      console.log(`   用法：整个 zip 发给 GPT，GPT 会自己按说明.txt 完成全部步骤`);
      break;
    }
    case 'place': {
      const src = rest[0];
      const out = flag(rest, '--out', '.');
      if (!src) { console.error('❌ place 需要 zip 解压目录'); process.exit(1); }
      placeImages(src, out);
      break;
    }
    case 'render': {
      let ok = true;
      const castS = flag(rest, '--cast-script');
      const artS = flag(rest, '--art-script');
      const sbS = flag(rest, '--sb-script');
      const cast = flag(rest, '--cast');
      const art = flag(rest, '--art');
      const sb = flag(rest, '--storyboard');
      const script = flag(rest, '--script');
      const outline = flag(rest, '--outline');
      const out = flag(rest, '--out', '.');

      if (!castS && !artS && !sbS) {
        console.error('❌ render 需要至少一个 --cast-script / --art-script / --sb-script');
        process.exit(1);
      }
      // 各 skill 的 render 命令把 HTML 打到 stdout（SKILL 里靠用户重定向 `> report.html` 落盘）。
      // novel-assets 补 report 要自动落盘：捕获 stdout 写约定命名，缺哪个跳过哪个
      const report = (scriptPath, args, file) => {
        const r = runScript(scriptPath, args);
        if (r.status === 0) {
          mkdirSync(out, { recursive: true });
          writeFileSync(join(out, file), r.stdout ?? '', 'utf8');
          console.log(`✅ 补 report → ${join(out, file)}`);
        }
        return r.status === 0;
      };
      if (castS && cast) ok = report(castS, ['render', cast, '--html'], 'cast-report.html') && ok;
      else if (castS) console.log('ℹ️ 有 --cast-script 但缺 --cast，跳过角色报告');
      if (artS && art) ok = report(artS, ['render', art, '--html'], 'art-report.html') && ok;
      else if (artS) console.log('ℹ️ 有 --art-script 但缺 --art，跳过美术报告');
      if (sbS && sb) {
        // storyboard render 需要：--script <剧本.json>（不是 storyboard 自己）+ --cast/--art 供 @绑定
        // + --outline 让"提示词禁人名"门生效（缺了该门跳过视为通过）
        if (!script) console.log('⚠️ 分镜报告需要 --script <script.json>（剧本），缺了绑定/台词门会误判');
        const args = ['render', sb, '--html'];
        if (cast) args.push('--cast', cast);
        if (art) args.push('--art', art);
        if (script) args.push('--script', script);
        if (outline) args.push('--outline', outline);
        ok = report(sbS, args, 'storyboard-report.html') && ok;
      }
      else if (sbS) console.log('ℹ️ 有 --sb-script 但缺 --storyboard，跳过分镜报告');
      if (!ok) process.exit(1);
      break;
    }
    case 'slug': {
      const n = rest[0];
      if (!n) { console.error('❌ slug 需要名字'); process.exit(1); }
      console.log(slug(n));
      break;
    }
    default:
      console.error(USAGE);
      process.exit(1);
  }
}

/* ------------------------------------------------------------------ */
/* 导出（selftest 用）                                                  */
/* ------------------------------------------------------------------ */

export { slug, buildCastLookup, buildArtLookup, resolveBinds, buildSetupTask, buildStoryboardTask, buildInstruction, packZip, placeImages };

/* ------------------------------------------------------------------ */
/* CLI 入口                                                            */
/* ------------------------------------------------------------------ */

// 被 import 时不跑 main（selftest 直接调用函数）；被 node 直接执行时跑 CLI
// 判断方式：argv[1] 解析出的绝对路径 === 本文件
import { realpathSync } from 'fs';
let isCli = false;
try {
  if (process.argv[1]) isCli = realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
} catch { /* argv[1] 不存在就当作被 import */ }
if (isCli) main(process.argv.slice(2));
