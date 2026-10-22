window.slideDataMap.set(15, `
  <div class="w-[1440px] h-[810px] shadow-2xl relative overflow-hidden slide-bg">
    <div class="absolute inset-0" style="background-image: linear-gradient(rgba(56,189,248,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(56,189,248,0.06) 1px, transparent 1px); background-size: 48px 48px;"></div>
    <div class="w-[1350px] h-[720px] mx-auto my-[45px] flex flex-col relative z-10">
      <div class="mb-8">
        <div class="text-amber-400 font-mono text-sm tracking-[0.3em] mb-2">[ P5 · 流式与交付 ]</div>
        <h1 class="text-4xl font-bold text-white">SSE 流式生成与交付链路</h1>
      </div>
      <div class="flex items-stretch justify-between gap-2 mb-8">
        <div class="flex-1 bg-slate-800/80 border-2 border-cyan-400 rounded-xl p-5 text-center"><div class="text-cyan-300 font-mono text-xs mb-1">REQ</div><div class="text-white text-[17px] font-bold">卡片触发</div></div>
        <div class="flex items-center text-cyan-400 text-2xl">→</div>
        <div class="flex-1 bg-slate-800/80 border-2 border-purple-400 rounded-xl p-5 text-center"><div class="text-purple-300 font-mono text-xs mb-1">STREAM</div><div class="text-white text-[17px] font-bold">kickoff-ppt-stream</div></div>
        <div class="flex items-center text-purple-400 text-2xl">→</div>
        <div class="flex-1 bg-slate-800/80 border-2 border-amber-400 rounded-xl p-5 text-center"><div class="text-amber-300 font-mono text-xs mb-1">ASSEMBLE</div><div class="text-white text-[17px] font-bold">流式装配</div></div>
        <div class="flex items-center text-amber-400 text-2xl">→</div>
        <div class="flex-1 bg-slate-800/80 border-2 border-blue-400 rounded-xl p-5 text-center"><div class="text-blue-300 font-mono text-xs mb-1">SAVE</div><div class="text-white text-[17px] font-bold">Buffer 落盘</div></div>
        <div class="flex items-center text-blue-400 text-2xl">→</div>
        <div class="flex-1 bg-slate-800/80 border-2 border-emerald-400 rounded-xl p-5 text-center"><div class="text-emerald-300 font-mono text-xs mb-1">DL</div><div class="text-white text-[17px] font-bold">saveBlob 下载</div></div>
      </div>
      <div class="grid grid-cols-3 gap-5 flex-1">
        <div class="bg-slate-900/70 border-l-4 border-cyan-400 rounded p-5"><h4 class="text-cyan-300 font-bold mb-2">SSE 范式</h4><p class="text-slate-300 text-[15px] leading-relaxed">复用 <span class="font-mono text-cyan-300">POST /api/plans/kickoff-ppt-stream</span>，事件 stage/chunk/done/error，客户端断开即 abort。</p></div>
        <div class="bg-slate-900/70 border-l-4 border-emerald-400 rounded p-5"><h4 class="text-emerald-300 font-bold mb-2">成品规格</h4><p class="text-slate-300 text-[15px] leading-relaxed">一次点击产出 <span class="text-emerald-300">12~18 页</span>原生 .pptx：甘特、工作量、风险、沟通管理齐全。</p></div>
        <div class="bg-slate-900/70 border-l-4 border-amber-400 rounded p-5"><h4 class="text-amber-300 font-bold mb-2">并发闸</h4><p class="text-slate-300 text-[15px] leading-relaxed">并发闸防流式生成<span class="text-amber-300">打满资源</span>；命名与下载走服务端 Buffer + Content-Disposition。</p></div>
      </div>
    </div>
  </div>
`);
