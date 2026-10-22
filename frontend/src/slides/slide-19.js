window.slideDataMap.set(19, `
  <div class="w-[1440px] h-[810px] shadow-2xl relative overflow-hidden slide-bg">
    <div class="absolute inset-0" style="background-image: linear-gradient(rgba(56,189,248,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(56,189,248,0.06) 1px, transparent 1px); background-size: 48px 48px;"></div>
    <div class="w-[1350px] h-[720px] mx-auto my-[45px] flex flex-col relative z-10">
      <div class="mb-6">
        <div class="text-cyan-400 font-mono text-sm tracking-[0.3em] mb-2">[ REVIEW · 对照与成效 ]</div>
        <h1 class="text-4xl font-bold text-white">能力对照与关键成效</h1>
      </div>
      <div class="grid grid-cols-2 grid-rows-2 gap-6 flex-1">
        <div class="bg-slate-800/70 border border-cyan-500/30 rounded-xl p-7">
          <div class="text-cyan-400 font-mono text-xs mb-2">四期 · 估算</div>
          <h3 class="text-xl font-bold text-cyan-300 mb-2">三点 → 报价</h3>
          <p class="text-slate-300 text-[15px] leading-relaxed">单点拍脑袋 → 三点法 + 置信区间，<span class="text-cyan-300">逐行可追溯</span>到需求与用例。</p>
        </div>
        <div class="bg-slate-800/70 border border-purple-500/30 rounded-xl p-7">
          <div class="text-purple-400 font-mono text-xs mb-2">四期 · 测试</div>
          <h3 class="text-xl font-bold text-purple-300 mb-2">库 + 覆盖 + AI</h3>
          <p class="text-slate-300 text-[15px] leading-relaxed">结构化用例库、P0~P3 覆盖度、<span class="text-purple-300">矩阵双向溯源</span>、AI 草稿生成。</p>
        </div>
        <div class="bg-slate-800/70 border border-emerald-500/30 rounded-xl p-7">
          <div class="text-emerald-400 font-mono text-xs mb-2">五期 · PPT</div>
          <h3 class="text-xl font-bold text-emerald-300 mb-2">资料 → 一键成稿</h3>
          <p class="text-slate-300 text-[15px] leading-relaxed">沉淀资料一键生成 <span class="text-emerald-300">12~18 页</span>可编辑 .pptx 启动会材料。</p>
        </div>
        <div class="bg-slate-800/70 border border-amber-500/30 rounded-xl p-7">
          <div class="text-amber-400 font-mono text-xs mb-2">成效</div>
          <h3 class="text-xl font-bold text-amber-300 mb-2">零新依赖 · 复用</h3>
          <p class="text-slate-300 text-[15px] leading-relaxed">沿用 exceljs/docx/pdfkit/pptxgenjs + worker 池；<span class="text-amber-300">不改渲染链</span>，维护成本低。</p>
        </div>
      </div>
    </div>
  </div>
`);
