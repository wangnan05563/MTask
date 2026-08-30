// 打包完成后仅保留必需语言包，减少安装体积。
// 这些 .pak 是 Electron 自带各语言 UI 资源，本产品面向中文用户，多数语言用不到。
// 通过 electron-builder 的 afterPack 钩子在 win-unpacked 输出阶段删除多余语言包。
const fs = require('fs');
const path = require('path');

exports.default = async function (context) {
  const loc = path.join(context.appOutDir, 'locales');
  if (!fs.existsSync(loc)) return;

  // 保留中文（简体）与英文，其余语言包全部删除
  const keep = new Set(['zh-CN.pak', 'en-US.pak']);
  let removed = 0;
  let removedBytes = 0;

  for (const f of fs.readdirSync(loc)) {
    if (!keep.has(f)) {
      const full = path.join(loc, f);
      removedBytes += fs.statSync(full).size;
      fs.unlinkSync(full);
      removed += 1;
    }
  }

  if (removed > 0) {
    console.log(
      `[trim-locales] 已删除 ${removed} 个多余语言包，省下 ${Math.round(removedBytes / 1024 / 1024)} MB`
    );
  }
};