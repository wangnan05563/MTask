window.slideDataMap.set(9, `
  <div class="w-[1440px] h-[810px] shadow-2xl relative overflow-hidden slide-bg">
    <div class="absolute inset-0" style="background-image: linear-gradient(rgba(56,189,248,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(56,189,248,0.06) 1px, transparent 1px); background-size: 48px 48px;"></div>
    <div class="w-[1350px] h-[720px] mx-auto my-[45px] flex flex-col relative z-10">
      <div class="mb-6">
        <div class="text-purple-400 font-mono text-sm tracking-[0.3em] mb-2">[ P4 · 导出 ]</div>
        <h1 class="text-4xl font-bold text-white">Excel / PDF 导出 · 交付即用</h1>
      </div>
      <div class="grid grid-cols-3 gap-6 flex-1">
        <div class="bg-slate-800/70 border border-cyan-500/40 rounded-xl p-7 flex flex-col">
          <div class="text-cyan-400 text-3xl mb-3 font-mono">.xlsx</div>
          <h3 class="text-xl font-bold text-cyan-300 mb-3">Excel 复刻模板</h3>
          <p class="text-slate-300 text-[15px] leading-relaxed">sheet 名、合并区、公式、命名区域、列宽<span class="text-cyan-300">逐格对齐客户模板</span>（阜新银行工作量评估表），无需二次排版。</p>
        </div>
        <div class="bg-slate-800/70 border border-purple-500/40 rounded-xl p-7 flex flex-col">
          <div class="text-purple-400 text-3xl mb-3 font-mono">.pdf</div>
          <h3 class="text-xl font-bold text-purple-300 mb-3">可交付 PDF</h3>
          <p class="text-slate-300 text-[15px] leading-relaxed">生成<span class="text-purple-300">可直接提交客户</span>的报价版 PDF；失败时快照留档 <span class="font-mono text-purple-300">estimate_snapshots</span>。</p>
        </div>
        <div class="bg-slate-800/70 border border-amber-500/40 rounded-xl p-7 flex flex-col">
          <div class="text-amber-400 text-3xl mb-3 font-mono">MCP</div>
          <h3 class="text-xl font-bold text-amber-300 mb-3">工具暴露</h3>
          <p class="text-slate-300 text-[15px] leading-relaxed">以 <span class="text-amber-300">mtask_*</span> 家族工具暴露，可被外部 Agent 直接调用，复用既有清单。</p>
        </div>
      </div>
      <div class="mt-6 flex items-center gap-4 px-6 py-4 bg-slate-900/70 border-l-4 border-emerald-400 rounded">
        <span class="text-emerald-300 font-mono text-sm">零新依赖</span>
        <span class="text-slate-300 text-[15px]">exceljs 4.4.0 · docx 9.7.1 · pdfkit 0.20.1（均在 server/package.json）；E0 Spike 已实测：{formula,result} 双写、命名区域写侧注入、28 处合并区无损。</span>
      </div>
    </div>
  </div>
`);
