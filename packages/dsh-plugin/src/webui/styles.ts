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

  /* Persistent two-row header: workspace controls, then navigation. */
  .app-frame { min-height: 100vh; }
  .topbar {
    background: var(--bg-elev-1); backdrop-filter: blur(18px);
    position: sticky; top: 0; z-index: 20; border-bottom: 1px solid var(--border-strong);
  }
  .topbar-inner, .topnav-inner {
    display: flex; align-items: center; gap: 18px; margin: 0 auto;
    max-width: 1520px; width: 100%; padding: 0 clamp(14px,3vw,46px);
  }
  .topbar-inner { min-height: 58px; }
  .topnav-inner { min-height: 44px; justify-content: space-between; }
  .topbar-brand, .topbar-actions, .workspace-label, .release-version, .topnav, .nav-tools { display: flex; align-items: center; }
  .topbar-brand { gap: 9px; }
  .brand-orb {
    width: 31px; height: 31px; border-radius: 9px; background: linear-gradient(135deg,var(--accent),var(--accent-2));
    display: grid; place-items: center; font-weight: 800; color: white; box-shadow: 0 0 16px var(--accent-soft);
  }
  .brand-name { font-size: 16px; font-weight: 700; letter-spacing:-.035em; }
  .workspace-label { color: var(--text-2); font-size: 12px; gap: 7px; min-width: 0; }
  .workspace-dot { height: 6px; width: 6px; border-radius: 50%; background:var(--emerald); flex-shrink: 0; }
  #hud-ws { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .topbar-actions { gap: 9px; margin-left:auto; }
  .release-version { border-left: 1px solid var(--border-strong); padding-left: 14px; gap: 7px; color: var(--text-2); font-size: 11px; white-space: nowrap; }
  .release-version b { color: var(--accent); background: var(--accent-soft); border-radius:4px; font: 600 12px/1.5 ui-monospace,Menlo,monospace; padding:2px 6px; }
  .topnav { gap: 4px; overflow-x: auto; min-width:0; }
  .nav-btn { display:inline-flex; align-items:center; gap:7px; padding:9px 14px; border:0; border-bottom:2px solid transparent; margin:0; background:transparent; color:var(--text-2); font: inherit; cursor:pointer; white-space:nowrap; }
  .nav-btn.active { color:var(--accent); border-bottom-color:var(--accent); font-weight:650; }
  .nav-btn:hover, .quiet-button:hover { color:var(--accent); }
  .nav-count { padding:0 5px; min-width:17px; line-height:17px; font-size:11px; border-radius:5px; color:var(--text-2); background:var(--bg-elev-3); }
  .nav-btn.active .nav-count { background: var(--accent-soft); color: var(--accent); }
  .nav-tools { gap:12px; }
  .mobile-actions { display:none; }
  .quiet-button { font:inherit; font-size:12px; color:var(--text-2); border:0; background:transparent; cursor:pointer; white-space:nowrap; }
  .stage { min-width: 0; }
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

  .stage-body { padding: 19px clamp(14px,3vw,46px) 48px; max-width: 1520px; width: 100%; margin: 0 auto; }
  .capture-fields { display:grid; grid-template-columns:minmax(0,2fr) minmax(0,1fr) minmax(0,1fr); gap:10px; }

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

  #library, #nav-index-host, #btn-gov-arch { scroll-margin-top: 80px; }
  [hidden] { display: none !important; }
  button { touch-action: manipulation; }
  button:focus-visible, summary:focus-visible, [tabindex]:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  h1, h2, p { margin: 0; }
  .view-heading, .library-heading, .action-row, .demo-banner, .more-filters, .receipt-hit {
    display: flex; align-items: center; flex-wrap: wrap; gap: 10px;
  }
  .view-heading, .library-heading { justify-content: space-between; margin-bottom: 16px; }
  .view-heading h1 { font-size: 25px; line-height: 1.4; letter-spacing: -.025em; }
  .view-heading p, .work-focus p { color: var(--text-2); margin-top: 4px; }
  .panel-head h2, .library-heading h2, .receipt-hit strong { font-size: 15px; }
  .work-focus { display: flex; justify-content: space-between; align-items: center; gap: 18px; padding: 15px 24px; margin-bottom: 12px;
    background: radial-gradient(ellipse at 94% 40%, var(--accent-soft), transparent 62%), var(--bg-elev-1); }
  .work-focus h2 { font-size: 19px; line-height: 1.4; }
  .work-focus .action-row { margin-top: 14px; }
  #constellation-svg-slot { flex: 0 0 auto; line-height: 0; }
  .work-focus .constellation-svg { width: 132px; height: 108px; }
  .overview-panel { margin-bottom: 24px; }
  .overview-panel summary, .receipt-panel summary { padding: 12px 16px; cursor: pointer; font-weight: 600; }
  .summary-meta, .library-heading h2 span { font-weight: 400; color: var(--text-2); margin-left: 6px; font-size: 12px; }
  .overview-body { padding: 0 14px 14px; }
  .overview-stats { display: grid; grid-template-columns: repeat(auto-fit,minmax(132px,1fr)); gap: 8px; }
  .layer-tile { font: inherit; font-size: 12px; color: var(--text-2); display: flex; align-items: center; justify-content: space-between; text-align: left; }
  .layer-tile strong { color: var(--text-1); font-size: 18px; }
  .library-heading { margin-top: 5px; margin-bottom: 10px; }
  #flt-q { min-width: 180px; flex: 1 1 240px; }
  .more-filters { width: 100%; }
  .empty-observatory h3 { margin: 0 0 6px; font-size: 15px; }
  .empty-observatory p { color: var(--text-2); margin: 4px auto 12px; }
  .empty-observatory .action-row { justify-content: center; }
  .demo-banner { justify-content: space-between; border: 1px solid var(--violet); background: var(--violet-soft); padding: 8px 14px; border-radius: 9px; margin-bottom: 16px; }
  .receipt-panel, .settings-panel { margin-bottom: 16px; }
  #receipt-host, #settings-host { padding: 12px 16px; }
  .settings-line { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 0; flex-wrap: wrap; }
  .settings-line p, .receipt-meta { color: var(--text-2); font-size: 12px; }
  .receipt-hit { justify-content: space-between; padding: 10px 12px; border-top: 1px solid var(--border-subtle); }
  .receipt-panel details { background: var(--bg-elev-2); border-radius: 8px; margin-bottom: 6px; }
  .sim-fields { display: grid; grid-template-columns: 1.4fr 1fr 1fr auto; gap: 10px; align-items: end; }
  .cmdk-item { width: 100%; background: transparent; border: 0; font: inherit; color: var(--text-1); text-align: left; }
  .table-scroll { overflow-x: auto; }
  .state-guide p + p { margin-top: 8px; }
  .matrix-4d { padding: 0; background: var(--bg-elev-2); }
  .vc-foot { flex-wrap: wrap; }
  .vc-title { overflow-wrap: anywhere; }
  .vc-top, .drawer-footer { flex-wrap: wrap; }
  .modal-mask { padding: min(8vh,80px) 8px 16px; }
  .modal-card { max-height: 86vh; overflow-y: auto; }
  select { max-width: 100%; }
  [data-theme="dark"] .btn-primary { color: #061b2b; }
  [data-theme="dark"] .form-hint, [data-theme="dark"] .panel-sub, [data-theme="dark"] .prism-label { color: #98a6bb; }

  .work-focus { justify-content:flex-start; flex-wrap:wrap; gap:12px; position:relative; padding:8px 14px; margin-bottom:17px; min-height:52px; }
  .work-focus-copy { min-width:0; }
  .work-focus-copy strong { font-size:13.5px; }
  .work-focus .action-row { margin-top:0; }
  .work-focus .action-row button { height:28px; font-size:12px; padding-inline:10px; }
  #constellation-svg-slot { margin-left:auto; }
  .work-focus .constellation-svg { width:58px; height:43px; }
  .library-heading { gap:12px; justify-content:space-between; }
  .scope-choices { display:flex; flex-wrap:wrap; align-items:center; gap:4px; }
  .scope-choices button { border:1px solid transparent; border-radius:7px; padding:6px 10px; font:inherit; font-size:13px; background:transparent; color:var(--text-2); cursor:pointer; white-space:nowrap; }
  .scope-choices button[aria-pressed="true"] { border-color:var(--border-highlight); background:var(--accent-soft); color:var(--accent); font-weight:650; }
  .scope-choices button:hover { color:var(--accent); }
  .scope-choices button span { font: 11px ui-monospace,Menlo,monospace; margin-left:4px; }
  .scope-choices button span:empty { display:none; }
  .result-caption, .digest-totals { color:var(--text-2); font-size:12.5px; }
  .result-caption { display:flex; gap:6px; margin:0 0 10px; }
  .overview-panel { margin:18px 0 0; }
  #library, #nav-index-host, #btn-gov-arch { scroll-margin-top:116px; }
  .knowledge-title, .summary-ref { border:0; padding:0; background:transparent; color:var(--text-1); font:inherit; text-align:left; cursor:pointer; }
  .knowledge-title:hover, .summary-ref:hover { color:var(--accent); text-decoration:underline; }
  .vault-grid { grid-template-columns:repeat(auto-fill,minmax(min(100%,360px),1fr)); align-items:stretch; }
  .knowledge-card { min-width:0; }
  .knowledge-card h3 { margin:0; font-size:15px; line-height:1.45; }
  .knowledge-claim { margin:0; line-height:1.65; color:var(--text-1); }
  .knowledge-facts { display:grid; gap:7px; margin:0; font-size:12.5px; }
  .knowledge-fact { display:grid; grid-template-columns:4.5em minmax(0,1fr); gap:6px; }
  .knowledge-fact dt { color:var(--text-2); }
  .knowledge-fact dd { margin:0; overflow-wrap:anywhere; }
  .knowledge-meta { display:flex; align-items:center; justify-content:flex-start; flex-wrap:wrap; gap:7px; font-size:12px; color:var(--text-2); }
  .knowledge-meta code { margin-left:auto; font-size:11px; }
  .knowledge-detail-summary { border-left:3px solid var(--accent); padding:10px 12px; margin:0 0 14px; background:var(--accent-soft); }
  .knowledge-table { min-width:980px; table-layout:fixed; }
  .knowledge-table th, .knowledge-table td { vertical-align:top; overflow-wrap:anywhere; }
  .knowledge-table thead th:nth-child(1) { width:17%; }
  .knowledge-table thead th:nth-child(2), .knowledge-table thead th:nth-child(3) { width:7%; }
  .knowledge-table thead th:nth-child(4), .knowledge-table thead th:nth-child(6) { width:19%; }
  .knowledge-table thead th:last-child { width:17%; }
  .knowledge-table td .matrix-4d { grid-template-columns:repeat(2,auto); }
  .knowledge-table .knowledge-meta { display:block; margin-top:5px; }
  .knowledge-table tbody th { font-weight:550; font-size:13px; }
  .digest-totals { margin:0 0 10px; }
  .knowledge-digest { margin-bottom:10px; padding:14px 16px; }
  .digest-head { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .digest-head strong { color:var(--accent); }
  .digest-head span, .knowledge-digest summary { font-size:12px; color:var(--text-2); }
  .knowledge-digest ul { list-style:none; margin:9px 0 0; padding:0; }
  .knowledge-digest li { padding:8px 0; overflow-wrap:anywhere; }
  .knowledge-digest li + li { border-top:1px solid var(--border-subtle); }
  .knowledge-digest li p { margin:3px 0 0; color:var(--text-2); }
  .summary-ref { font-weight:600; }
  .summary-ref code { margin-left:5px; color:var(--accent); font-size:11px; white-space:nowrap; }
  .knowledge-digest summary { cursor:pointer; }
  @media (max-width: 960px) {
    .sim-fields { grid-template-columns:1fr 1fr; }
    .topbar-inner, .topnav-inner { gap:10px; }
    .topbar-inner .cmdk-trigger > span:first-child { display:none; }
  }
  @media (max-width: 700px) {
    .topbar-inner, .topnav-inner { padding-inline:9px; }
    .topbar-inner { min-height:46px; }
    .topbar-actions { gap:5px; }
    .topbar-brand { gap:5px; }
    .brand-name { font-size:14px; }
    .brand-orb { width:24px; height:24px; border-radius:6px; }
    .workspace-label { display:none; }
    .topbar-inner .cmdk-trigger { display:none; }
    .topbar-actions .btn { height:28px; padding-inline:6px; font-size:11px; }
    .release-version { padding-left:5px; gap:3px; }
    .release-version b { font-size:10px; padding:1px 3px; }
    .topnav-inner { min-height:39px; }
    .topnav { gap:0; width:100%; }
    .topnav .nav-btn { padding:7px 8px; gap:4px; font-size:12px; }
    .nav-tools { display:none; }
    .mobile-actions { display:inline-block; }
    .stage-body { padding:12px 9px 26px; }
    .work-focus { padding:9px 10px; gap:7px; }
    #constellation-svg-slot { display:none; }
    .scope-choices { width:100%; flex-wrap:nowrap; overflow:auto; padding-bottom:3px; }
    .scope-choices button { padding-inline:6px; font-size:12px; }
    .library-heading { gap:5px; }
    .sim-fields { grid-template-columns:1fr; }
    .capture-fields { grid-template-columns:1fr 1fr; }
    .capture-fields > :first-child { grid-column:1 / -1; }
    .drawer-panel { max-width:100vw; }
    .drawer-header, .drawer-scroll, .drawer-footer, .drawer-tabs { padding-inline:12px; }
    .prism-card, .lane-card { min-width:0; overflow-wrap:anywhere; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; scroll-behavior: auto !important; }
  }
`;
