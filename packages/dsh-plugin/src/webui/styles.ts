export const ACCREMIND_OBSERVATORY_STYLES = `
  :root, [data-theme="dark"] {
    --bg-canvas: #07090e;
    --bg-grid: rgba(148, 163, 184, 0.045);
    --bg-glow-1: rgba(56, 189, 248, 0.11);
    --bg-glow-2: rgba(99, 102, 241, 0.10);
    --bg-elev-1: rgba(15, 19, 28, 0.88);
    --bg-elev-2: #131926;
    --bg-elev-3: #1a2234;
    --bg-code: #0b0e16;
    --border-subtle: rgba(148, 163, 184, 0.12);
    --border-strong: rgba(148, 163, 184, 0.24);
    --border-highlight: rgba(56, 189, 248, 0.42);
    --text-1: #f1f5f9;
    --text-2: #94a3b8;
    --text-3: #64748b;
    --accent: #38bdf8;
    --accent-2: #818cf8;
    --accent-soft: rgba(56, 189, 248, 0.13);
    --emerald: #10b981;
    --emerald-soft: rgba(16, 185, 129, 0.14);
    --amber: #f59e0b;
    --amber-soft: rgba(245, 158, 11, 0.15);
    --crimson: #f43f5e;
    --crimson-soft: rgba(244, 63, 94, 0.15);
    --violet: #a78bfa;
    --violet-soft: rgba(167, 139, 250, 0.15);
    --shadow-lg: 0 20px 45px -12px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.05);
    --shadow-card: 0 4px 20px -4px rgba(0, 0, 0, 0.4);
  }

  [data-theme="light"] {
    --bg-canvas: #f4f6fb;
    --bg-grid: rgba(15, 23, 42, 0.04);
    --bg-glow-1: rgba(37, 99, 235, 0.07);
    --bg-glow-2: rgba(99, 102, 241, 0.06);
    --bg-elev-1: rgba(255, 255, 255, 0.92);
    --bg-elev-2: #ffffff;
    --bg-elev-3: #f1f5f9;
    --bg-code: #0f172a;
    --border-subtle: #e2e8f0;
    --border-strong: #cbd5e1;
    --border-highlight: #3b82f6;
    --text-1: #0f172a;
    --text-2: #475569;
    --text-3: #64748b;
    --accent: #2563eb;
    --accent-2: #4f46e5;
    --accent-soft: rgba(37, 99, 235, 0.09);
    --emerald: #059669;
    --emerald-soft: rgba(5, 150, 105, 0.10);
    --amber: #d97706;
    --amber-soft: rgba(217, 119, 6, 0.11);
    --crimson: #e11d48;
    --crimson-soft: rgba(225, 29, 72, 0.10);
    --violet: #7c3aed;
    --violet-soft: rgba(124, 58, 237, 0.10);
    --shadow-lg: 0 20px 40px -15px rgba(15, 23, 42, 0.16), 0 0 0 1px rgba(15, 23, 42, 0.06);
    --shadow-card: 0 2px 10px -2px rgba(15, 23, 42, 0.06);
  }

  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    font-size: 13.5px;
    line-height: 1.55;
    color: var(--text-1);
    background-color: var(--bg-canvas);
    background-image:
      radial-gradient(ellipse 70% 45% at 18% -8%, var(--bg-glow-1), transparent),
      radial-gradient(ellipse 55% 40% at 85% 0%, var(--bg-glow-2), transparent),
      linear-gradient(var(--bg-grid) 1px, transparent 1px),
      linear-gradient(90deg, var(--bg-grid) 1px, transparent 1px);
    background-size: 100% 100%, 100% 100%, 28px 28px, 28px 28px;
    background-attachment: fixed;
    -webkit-font-smoothing: antialiased;
  }

  code, pre, .mono {
    font-family: "JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace;
  }

  /* Layout Shell */
  .app-frame { display: flex; min-height: 100vh; }

  .rail {
    width: 248px;
    background: var(--bg-elev-1);
    backdrop-filter: blur(18px);
    border-right: 1px solid var(--border-subtle);
    display: flex;
    flex-direction: column;
    padding: 18px 12px;
    position: sticky;
    top: 0;
    height: 100vh;
    flex-shrink: 0;
    z-index: 20;
  }

  .brand-box {
    display: flex;
    align-items: center;
    gap: 11px;
    padding: 6px 10px 18px;
    border-bottom: 1px solid var(--border-subtle);
    margin-bottom: 14px;
  }
  .brand-orb {
    width: 34px; height: 34px; border-radius: 10px;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    display: grid; place-items: center;
    color: #fff; font-weight: 800; font-size: 15px;
    box-shadow: 0 0 22px var(--accent-soft);
    flex-shrink: 0;
  }
  .brand-name { font-size: 15px; font-weight: 700; letter-spacing: -0.02em; }
  .brand-tag { font-size: 11px; color: var(--text-3); letter-spacing: 0.02em; }

  .rail-group-label {
    font-size: 10.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-3);
    padding: 10px 12px 6px;
  }

  .nav-btn {
    display: flex; align-items: center; justify-content: space-between;
    width: 100%; border: 1px solid transparent; background: transparent;
    color: var(--text-2); padding: 9px 12px; margin: 2px 0;
    border-radius: 8px; cursor: pointer; font: inherit; font-weight: 500;
    transition: all 0.16s ease; text-align: left;
  }
  .nav-btn:hover { background: var(--bg-elev-3); color: var(--text-1); }
  .nav-btn.active {
    background: var(--accent-soft);
    border-color: var(--border-highlight);
    color: var(--accent);
    font-weight: 600;
  }
  .nav-left { display: flex; align-items: center; gap: 9px; }
  .nav-count {
    font-size: 11px; font-family: "JetBrains Mono", monospace;
    padding: 1px 7px; border-radius: 999px;
    background: var(--bg-elev-3); color: var(--text-2);
    border: 1px solid var(--border-subtle);
  }
  .nav-btn.active .nav-count {
    background: var(--accent); color: #05080f; border-color: transparent; font-weight: 700;
  }

  .rail-footer {
    margin-top: auto;
    padding: 12px 10px 4px;
    border-top: 1px solid var(--border-subtle);
    font-size: 11.5px;
    color: var(--text-3);
  }
  .pulse-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; color: var(--text-2); }
  .pulse-dot {
    width: 8px; height: 8px; border-radius: 50%; background: var(--emerald);
    box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7);
    animation: pulseGlow 2.4s infinite;
  }
  @keyframes pulseGlow {
    0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.6); }
    70% { box-shadow: 0 0 0 7px rgba(16, 185, 129, 0); }
    100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
  }

  /* Main Stage */
  .stage { flex: 1; min-width: 0; display: flex; flex-direction: column; }

  .hud-bar {
    height: 60px;
    background: var(--bg-elev-1);
    backdrop-filter: blur(16px);
    border-bottom: 1px solid var(--border-subtle);
    padding: 0 26px;
    display: flex; align-items: center; justify-content: space-between; gap: 16px;
    position: sticky; top: 0; z-index: 15;
  }
  .hud-left { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .ws-pill {
    display: inline-flex; align-items: center; gap: 7px;
    padding: 4px 11px; border-radius: 999px;
    background: var(--bg-elev-2); border: 1px solid var(--border-subtle);
    font-size: 12px; color: var(--text-1); font-weight: 600;
  }
  .cmdk-trigger {
    display: inline-flex; align-items: center; gap: 14px;
    height: 34px; padding: 0 12px; border-radius: 8px;
    background: var(--bg-elev-2); border: 1px solid var(--border-subtle);
    color: var(--text-3); cursor: pointer; font-size: 12.5px;
    transition: border-color 0.15s ease;
  }
  .cmdk-trigger:hover { border-color: var(--border-highlight); color: var(--text-1); }
  .kbd {
    font-family: "JetBrains Mono", monospace; font-size: 10.5px;
    padding: 1px 5px; border-radius: 4px;
    background: var(--bg-elev-3); border: 1px solid var(--border-strong); color: var(--text-2);
  }
  .hud-actions { display: flex; align-items: center; gap: 8px; }

  /* Buttons & Inputs */
  .btn {
    height: 34px; padding: 0 13px; border-radius: 8px;
    border: 1px solid var(--border-strong); background: var(--bg-elev-2);
    color: var(--text-1); font: inherit; font-size: 12.5px; font-weight: 500;
    cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
    transition: all 0.15s ease; white-space: nowrap;
  }
  .btn:hover { border-color: var(--accent); color: var(--accent); transform: translateY(-0.5px); }
  .btn-sm { height: 28px; padding: 0 10px; font-size: 12px; border-radius: 6px; }
  .btn-primary {
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    border-color: transparent; color: #ffffff; font-weight: 600;
    box-shadow: 0 4px 14px var(--accent-soft);
  }
  .btn-primary:hover { filter: brightness(1.08); color: #ffffff; border-color: transparent; }
  .btn-emerald {
    background: var(--emerald-soft); border-color: var(--emerald); color: var(--emerald); font-weight: 600;
  }
  .btn-emerald:hover { background: var(--emerald); color: #fff; }
  .btn-crimson {
    background: var(--crimson-soft); border-color: var(--crimson); color: var(--crimson); font-weight: 600;
  }
  .btn-crimson:hover { background: var(--crimson); color: #fff; }
  .btn:disabled { opacity: 0.42; pointer-events: none; }

  input, select, textarea {
    font: inherit; font-size: 13px; color: var(--text-1);
    background: var(--bg-elev-2); border: 1px solid var(--border-strong);
    border-radius: 8px; padding: 7px 11px; outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  input:focus, select:focus, textarea:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }

  .stage-body { padding: 22px 26px 48px; max-width: 1440px; width: 100%; margin: 0 auto; }

  /* Observatory Bento Hero */
  .hero-bento {
    display: grid;
    grid-template-columns: 1.35fr 1fr;
    gap: 16px;
    margin-bottom: 22px;
  }
  @media (max-width: 1080px) { .hero-bento { grid-template-columns: 1fr; } }

  .glass-panel {
    background: var(--bg-elev-1);
    backdrop-filter: blur(14px);
    border: 1px solid var(--border-subtle);
    border-radius: 14px;
    box-shadow: var(--shadow-card);
    overflow: hidden;
  }
  .panel-head {
    padding: 13px 18px;
    border-bottom: 1px solid var(--border-subtle);
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
  }
  .panel-title { font-weight: 650; font-size: 13.5px; display: flex; align-items: center; gap: 8px; }
  .panel-sub { font-size: 12px; color: var(--text-3); }

  .constellation-wrap {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 20px; gap: 18px; min-height: 196px;
  }
  .constellation-svg { width: 220px; height: 176px; flex-shrink: 0; overflow: visible; }
  .orbit-ring { fill: none; stroke: var(--border-subtle); stroke-dasharray: 3 4; }
  .orbit-node { cursor: pointer; transition: transform 0.2s ease; }
  .orbit-node:hover { filter: brightness(1.25); }

  .constellation-legend { flex: 1; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .layer-tile {
    padding: 10px 12px; border-radius: 10px;
    background: var(--bg-elev-2); border: 1px solid var(--border-subtle);
    cursor: pointer; transition: border-color 0.15s, transform 0.15s;
  }
  .layer-tile:hover { border-color: var(--accent); transform: translateY(-1px); }
  .layer-tile-top { display: flex; justify-content: space-between; align-items: center; font-size: 11.5px; color: var(--text-2); }
  .layer-tile-num { font-size: 20px; font-weight: 700; font-family: "JetBrains Mono", monospace; margin-top: 3px; }

  .telemetry-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 16px 18px;
  }
  .metric-cell {
    padding: 12px 14px; border-radius: 10px;
    background: var(--bg-elev-2); border: 1px solid var(--border-subtle);
    display: flex; flex-direction: column; justify-content: space-between;
  }
  .metric-k { font-size: 11.5px; color: var(--text-2); display: flex; align-items: center; justify-content: space-between; }
  .metric-v { font-size: 24px; font-weight: 750; font-family: "JetBrains Mono", monospace; margin-top: 6px; letter-spacing: -0.03em; }

  /* 4D Orthogonal State Matrix Strip (L6: Strictly No Percentages!) */
  .matrix-4d {
    display: inline-grid; grid-template-columns: repeat(4, auto);
    border: 1px solid var(--border-strong); border-radius: 7px; overflow: hidden;
    font-family: "JetBrains Mono", monospace; font-size: 10.5px; cursor: pointer;
  }
  .m4-cell {
    padding: 2px 7px; border-right: 1px solid var(--border-subtle);
    background: var(--bg-elev-2); color: var(--text-2); white-space: nowrap;
  }
  .m4-cell:last-child { border-right: none; }
  .m4-ok { background: var(--emerald-soft); color: var(--emerald); font-weight: 600; }
  .m4-prob { background: var(--violet-soft); color: var(--violet); font-weight: 600; }
  .m4-warn { background: var(--amber-soft); color: var(--amber); font-weight: 600; }
  .m4-err { background: var(--crimson-soft); color: var(--crimson); font-weight: 600; }

  /* Probation 3-Pip Lifespan Meter */
  .pip-meter { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--violet); }
  .pip { width: 7px; height: 7px; border-radius: 50%; border: 1px solid var(--violet); }
  .pip.used { background: var(--violet); }

  /* Chips & Tags */
  .tag {
    display: inline-flex; align-items: center; gap: 4px;
    font-size: 11.5px; padding: 2px 8px; border-radius: 6px;
    background: var(--bg-elev-3); border: 1px solid var(--border-subtle); color: var(--text-2);
  }
  .tag-p0 { background: var(--crimson-soft); border-color: rgba(244,63,94,0.35); color: var(--crimson); font-weight: 700; }
  .tag-p1 { background: var(--amber-soft); border-color: rgba(245,158,11,0.35); color: var(--amber); font-weight: 600; }
  .tag-type { background: var(--accent-soft); border-color: rgba(56,189,248,0.3); color: var(--accent); font-weight: 600; }

  /* Filter Toolbar & Segmented Switch */
  .toolbar {
    display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
    gap: 10px; margin-bottom: 16px;
  }
  .toolbar-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; flex: 1; }
  .seg-group {
    display: inline-flex; background: var(--bg-elev-2); padding: 3px;
    border-radius: 8px; border: 1px solid var(--border-subtle);
  }
  .seg-btn {
    border: none; background: transparent; color: var(--text-2);
    padding: 4px 11px; border-radius: 6px; font-size: 12px; cursor: pointer; font-weight: 500;
  }
  .seg-btn.active { background: var(--bg-elev-3); color: var(--text-1); font-weight: 600; box-shadow: 0 1px 3px rgba(0,0,0,0.2); }

  /* Vault Card Grid & Dense Table */
  .vault-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(390px, 1fr)); gap: 14px;
  }
  .vault-card {
    background: var(--bg-elev-1); border: 1px solid var(--border-subtle);
    border-radius: 12px; padding: 16px 18px; display: flex; flex-direction: column; gap: 10px;
    transition: border-color 0.16s ease, transform 0.16s ease, box-shadow 0.16s ease;
    position: relative;
  }
  .vault-card:hover {
    border-color: var(--border-highlight);
    transform: translateY(-2px);
    box-shadow: var(--shadow-card);
  }
  .vc-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .vc-title { font-size: 14.5px; font-weight: 650; line-height: 1.4; cursor: pointer; }
  .vc-title:hover { color: var(--accent); }
  .vc-delta {
    font-size: 12.5px; color: var(--text-2); background: var(--bg-elev-2);
    border-left: 3px solid var(--accent); padding: 8px 11px; border-radius: 0 8px 8px 0;
  }
  .vc-aliases { display: flex; flex-wrap: wrap; gap: 5px; }
  .vc-foot {
    margin-top: auto; padding-top: 10px; border-top: 1px solid var(--border-subtle);
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
  }

  table.data-tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
  .data-tbl th {
    text-align: left; padding: 11px 14px; font-size: 11.5px; text-transform: uppercase;
    letter-spacing: 0.04em; color: var(--text-3); border-bottom: 1px solid var(--border-subtle);
    background: var(--bg-elev-2);
  }
  .data-tbl td { padding: 12px 14px; border-bottom: 1px solid var(--border-subtle); vertical-align: middle; }
  .data-tbl tr:hover td { background: var(--bg-elev-2); }

  /* Delta Prism Split Comparison (Tab 2) */
  .prism-card {
    background: var(--bg-elev-1); border: 1px solid var(--border-subtle);
    border-radius: 14px; padding: 18px 20px; margin-bottom: 16px;
  }
  .prism-grid {
    display: grid; grid-template-columns: 1fr 38px 1fr; gap: 12px; align-items: stretch; margin: 14px 0;
  }
  @media (max-width: 920px) { .prism-grid { grid-template-columns: 1fr; } .prism-divider { display: none; } }
  .prism-pane {
    padding: 14px 16px; border-radius: 10px; border: 1px solid var(--border-subtle);
    background: var(--bg-elev-2);
  }
  .prism-pane.delta {
    background: linear-gradient(160deg, var(--accent-soft), transparent 85%);
    border-color: var(--border-highlight);
  }
  .prism-divider {
    display: flex; align-items: center; justify-content: center;
    font-family: "JetBrains Mono", monospace; font-weight: 800; color: var(--accent); font-size: 16px;
  }
  .prism-label {
    font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
    margin-bottom: 6px; color: var(--text-3);
  }
  .prism-pane.delta .prism-label { color: var(--accent); }

  /* 3-Lane Context Compiler Reactor (Tab 3) */
  .lanes-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-top: 16px; }
  @media (max-width: 1100px) { .lanes-grid { grid-template-columns: 1fr; } }
  .lane-card {
    background: var(--bg-elev-2); border: 1px solid var(--border-subtle);
    border-radius: 12px; padding: 15px 16px; display: flex; flex-direction: column; gap: 10px;
  }
  .budget-bar {
    height: 6px; border-radius: 999px; background: var(--bg-elev-3); overflow: hidden;
  }
  .budget-fill {
    height: 100%; border-radius: 999px;
    background: linear-gradient(90deg, var(--accent), var(--emerald));
    transition: width 0.3s ease;
  }
  .code-vault {
    background: var(--bg-code); color: #e2e8f0; border: 1px solid var(--border-subtle);
    border-radius: 8px; padding: 11px 13px; font-size: 12px; line-height: 1.5;
    white-space: pre-wrap; word-break: break-word; max-height: 260px; overflow: auto;
  }
  .l1-lock-pill {
    font-size: 10.5px; font-family: "JetBrains Mono", monospace;
    padding: 2px 7px; border-radius: 4px;
    background: rgba(16, 185, 129, 0.14); color: var(--emerald);
  }

  /* Empty / Diagnostic Banners */
  .empty-observatory {
    text-align: center; padding: 44px 24px;
    border: 1px dashed var(--border-strong); border-radius: 14px;
    background: var(--bg-elev-2);
  }
  .alert-box {
    padding: 11px 15px; border-radius: 10px; font-size: 12.5px; margin-bottom: 12px;
    border: 1px solid var(--border-subtle);
  }
  .alert-s03 { background: var(--accent-soft); border-color: var(--border-highlight); }
  .alert-s02 { background: var(--amber-soft); border-color: var(--amber); color: var(--amber); }
  .alert-s01 { background: var(--crimson-soft); border-color: var(--crimson); color: var(--crimson); }

  /* Slide-over Inspector Drawer */
  .backdrop {
    position: fixed; inset: 0; background: rgba(3, 6, 14, 0.62);
    backdrop-filter: blur(5px); z-index: 60; display: none; justify-content: flex-end;
  }
  .backdrop.open { display: flex; }
  .drawer-panel {
    width: 740px; max-width: 96vw; height: 100%;
    background: var(--bg-elev-2); border-left: 1px solid var(--border-strong);
    box-shadow: var(--shadow-lg); display: flex; flex-direction: column;
    animation: slideInRight 0.18s ease-out;
  }
  @keyframes slideInRight {
    from { transform: translateX(28px); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }
  .drawer-header {
    padding: 16px 22px; border-bottom: 1px solid var(--border-subtle);
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
  }
  .drawer-tabs {
    display: flex; gap: 6px; padding: 10px 22px 0; border-bottom: 1px solid var(--border-subtle);
    background: var(--bg-elev-1);
  }
  .d-tab {
    padding: 8px 14px; border: none; background: transparent; color: var(--text-2);
    font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer;
    border-bottom: 2px solid transparent;
  }
  .d-tab.active { color: var(--accent); border-bottom-color: var(--accent); }
  .drawer-scroll { padding: 20px 22px; overflow-y: auto; flex: 1; }
  .drawer-footer {
    padding: 13px 22px; border-top: 1px solid var(--border-subtle);
    background: var(--bg-elev-1); display: flex; align-items: center; justify-content: space-between; gap: 10px;
  }

  .form-row { margin-bottom: 14px; }
  .form-row label { display: block; font-weight: 600; font-size: 12.5px; margin-bottom: 3px; }
  .form-hint { font-size: 11.5px; color: var(--text-3); margin-bottom: 5px; }
  .form-row input, .form-row textarea, .form-row select { width: 100%; }

  /* Command Palette & Custom Modals */
  .modal-mask {
    position: fixed; inset: 0; background: rgba(3, 6, 14, 0.66);
    backdrop-filter: blur(6px); z-index: 80; display: none;
    align-items: flex-start; justify-content: center; padding-top: 88px;
  }
  .modal-mask.open { display: flex; }
  .modal-card {
    width: 560px; max-width: 94vw; background: var(--bg-elev-2);
    border: 1px solid var(--border-strong); border-radius: 14px;
    box-shadow: var(--shadow-lg); overflow: hidden;
    animation: popScale 0.14s ease-out;
  }
  @keyframes popScale {
    from { transform: scale(0.97) translateY(-6px); opacity: 0; }
    to { transform: scale(1) translateY(0); opacity: 1; }
  }
  .cmdk-input {
    width: 100%; border: none; border-bottom: 1px solid var(--border-subtle);
    border-radius: 0; padding: 15px 18px; font-size: 14.5px; background: transparent;
  }
  .cmdk-input:focus { box-shadow: none; }
  .cmdk-list { max-height: 340px; overflow-y: auto; padding: 8px; }
  .cmdk-item {
    padding: 9px 12px; border-radius: 8px; cursor: pointer;
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
  }
  .cmdk-item:hover { background: var(--accent-soft); color: var(--accent); }

  .toast-pill {
    position: fixed; bottom: 24px; right: 24px; z-index: 120;
    background: var(--bg-elev-2); border: 1px solid var(--border-highlight);
    box-shadow: var(--shadow-lg); padding: 10px 16px; border-radius: 10px;
    font-size: 13px; font-weight: 500; display: none;
  }
`;
