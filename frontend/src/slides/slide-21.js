window.slideDataMap.set(21, `
  <div class="w-[1440px] h-[810px] relative overflow-hidden slide-bg">
    <svg style="position:absolute;width:100%;height:100%;opacity:0.3;">
      <defs>
        <linearGradient id="end-flow" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" style="stop-color:#38bdf8;stop-opacity:0"/>
          <stop offset="50%" style="stop-color:#38bdf8;stop-opacity:1"/>
          <stop offset="100%" style="stop-color:#38bdf8;stop-opacity:0"/>
        </linearGradient>
      </defs>
      <rect x="0" y="22%" width="100%" height="2" fill="url(#end-flow)"><animate attributeName="y" values="0%;100%" dur="4s" repeatCount="indefinite"/></rect>
      <rect x="0" y="55%" width="100%" height="2" fill="url(#end-flow)"><animate attributeName="y" values="0%;100%" dur="5s" repeatCount="indefinite"/></rect>
    </svg>
    <div class="absolute inset-0 flex flex-col items-center justify-center z-[2]">
      <div style="padding:50px 90px;background:rgba(10,14,26,0.9);border:2px solid #38bdf8;box-shadow:0 0 50px rgba(56,189,248,0.4);">
        <div class="text-[60px] font-bold text-[#38bdf8] mb-8 text-center" style="letter-spacing:6px;text-shadow:0 0 30px rgba(56,189,248,0.6);">谢谢</div>
        <div class="text-[26px] text-[#38bdf8] text-center" style="letter-spacing:3px;font-family:'Courier New',monospace;">MTask 团队 · 资料沉淀 → 报价 → 成稿</div>
      </div>
    </div>
  </div>
`);
