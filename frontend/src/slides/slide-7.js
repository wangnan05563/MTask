window.slideDataMap.set(7, `
  <div class="w-[1440px] h-[810px] shadow-2xl relative overflow-hidden slide-bg">
    <div class="absolute inset-0" style="background-image: linear-gradient(rgba(56,189,248,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(56,189,248,0.06) 1px, transparent 1px); background-size: 48px 48px;"></div>
    <div class="w-[1350px] h-[720px] mx-auto my-[45px] flex flex-col relative z-10">
      <div class="mb-6">
        <div class="text-cyan-400 font-mono text-sm tracking-[0.3em] mb-2">[ P4 · 估算面板 ]</div>
        <h1 class="text-4xl font-bold text-white">估算面板与三点估算</h1>
        <p class="text-slate-400 text-[16px] mt-2">把单点拍脑袋，升级为可追溯的三点估算口径</p>
      </div>
      <div class="grid grid-cols-2 grid-rows-2 gap-6 flex-1">
        <div class="bg-slate-800/70 border border-cyan-500/30 rounded-xl p-7">
          <div class="flex items-center gap-3 mb-3"><div class="w-9 h-9 rounded bg-cyan-500/20 flex items-center justify-center text-cyan-300 font-mono text-sm">01</div><h3 class="text-xl font-bold text-cyan-300">入口与布局</h3></div>
          <p class="text-slate-300 text-[16px] leading-relaxed">在「项目管理」时间线视图右侧新增 <span class="text-cyan-300">估算面板</span>；每条计划条目即一个估算对象，沿用既有布局与 UI 守卫。</p>
        </div>
        <div class="bg-slate-800/70 border border-purple-500/30 rounded-xl p-7">
          <div class="flex items-center gap-3 mb-3"><div class="w-9 h-9 rounded bg-purple-500/20 flex items-center justify-center text-purple-300 font-mono text-sm">02</div><h3 class="text-xl font-bold text-purple-300">三点录入</h3></div>
          <p class="text-slate-300 text-[16px] leading-relaxed">每行录入 <span class="text-purple-300">乐观 O / 最可能 M / 悲观 P</span>；支持批量填充与逐条覆盖，复杂度→系数可冷启动推导。</p>
        </div>
        <div class="bg-slate-800/70 border border-amber-500/30 rounded-xl p-7">
          <div class="flex items-center gap-3 mb-3"><div class="w-9 h-9 rounded bg-amber-500/20 flex items-center justify-center text-amber-300 font-mono text-sm">03</div><h3 class="text-xl font-bold text-amber-300">实时可视化</h3></div>
          <p class="text-slate-300 text-[16px] leading-relaxed">不确定度随录入<span class="text-amber-300">实时可见</span>；标准差 / 置信区间让"估了多少、有多不确定"同时呈现。</p>
        </div>
        <div class="bg-slate-800/70 border border-emerald-500/30 rounded-xl p-7">
          <div class="flex items-center gap-3 mb-3"><div class="w-9 h-9 rounded bg-emerald-500/20 flex items-center justify-center text-emerald-300 font-mono text-sm">04</div><h3 class="text-xl font-bold text-emerald-300">数据联动</h3></div>
          <p class="text-slate-300 text-[16px] leading-relaxed">每条估算锚定计划条目与需求编号，<span class="text-emerald-300">客户质询可逐行回放</span>到需求与用例，全程可追溯。</p>
        </div>
      </div>
    </div>
  </div>
`);
