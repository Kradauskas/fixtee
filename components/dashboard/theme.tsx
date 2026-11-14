const CSS = `
.fx {
  --success: oklch(0.696 0.17 162.48);
  --warning: oklch(0.769 0.188 70.08);
  --ai: oklch(0.606 0.25 292.7);
  --radius: 0.5rem;
  --background: oklch(0.145 0.012 275);
  --foreground: oklch(0.96 0.004 275);
  --card: oklch(0.19 0.016 275);
  --primary: oklch(0.70 0.19 155);
  --primary-foreground: oklch(0.145 0.025 155);
  --secondary: oklch(0.245 0.016 275);
  --secondary-foreground: oklch(0.94 0.004 275);
  --muted: oklch(0.225 0.016 275);
  --muted-foreground: oklch(0.62 0.016 275);
  --accent: oklch(0.26 0.019 275);
  --destructive: oklch(0.637 0.237 25);
  --destructive-foreground: oklch(0.96 0.004 275);
  --border: oklch(0.96 0.004 275 / 8%);
  --input: oklch(0.96 0.004 275 / 12%);
  --ring: oklch(0.70 0.19 155);
  --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  min-height: 100vh;
  background: var(--background);
  color: var(--foreground);
  font-size: 13px;
  letter-spacing: 0;
}
.fx *, .fx *::before, .fx *::after { box-sizing: border-box; border-color: var(--border); }
.fx button, .fx input, .fx select { font: inherit; color: inherit; }
.fx button { cursor: pointer; background: none; border: 0; padding: 0; }
.fx h1, .fx h2, .fx h3, .fx h4, .fx p, .fx pre { margin: 0; }
.fx ul { margin: 0; padding: 0; list-style: none; }
.fx a { color: inherit; text-decoration: none; }

.topbar { height: 64px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; padding: 0 36px; gap: 20px; }
.brand { display: flex; gap: 11px; align-items: center; font-size: 23px; font-weight: 800; }
.brand-mark { width: 32px; height: 34px; color: var(--primary); }
.brand-tag { margin-left: 17px; border-left: 1px solid var(--border); padding-left: 18px; font-size: 11px; font-weight: 500; color: var(--muted-foreground); }
.top-actions { display: flex; align-items: center; gap: 13px; }
.ghost-button { display: inline-flex; align-items: center; gap: 7px; border-radius: 6px; padding: 6px 9px; color: var(--foreground); }
.ghost-button:hover { background: var(--accent); }
.repo-selector span { font-size: 11px; color: var(--muted-foreground); }
.avatar { width: 29px; height: 29px; background: var(--secondary); border: 1px solid var(--border); border-radius: 50%; display: grid; place-items: center; font-size: 10px; margin-left: 8px; }
.topbar-divider { height: 20px; border-left: 1px solid var(--border); margin: 0 4px; }

.dashboard { max-width: 1008px; margin: auto; padding: 26px 24px 0; }
.page-heading { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; gap: 16px; flex-wrap: wrap; }
.page-heading h1 { font-size: 27px; font-weight: 650; margin: 0 0 7px; }
.page-heading p { color: var(--muted-foreground); font-size: 12px; }
.heading-actions { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; justify-content: flex-end; }
.live-status { display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--muted-foreground); }
.live-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--success); box-shadow: 0 0 0 4px color-mix(in oklab, var(--success) 9%, transparent); animation: pulse-dot 2.5s infinite; }
@keyframes pulse-dot { 50% { box-shadow: 0 0 0 5px color-mix(in oklab, var(--success) 3%, transparent); } }
.simulate-button { display: inline-flex; align-items: center; gap: 7px; background: var(--foreground); color: var(--background); border-radius: 6px; padding: 7px 12px; font-size: 12px; font-weight: 550; }
.simulate-button:hover { opacity: 0.9; }
.simulate-button:disabled { opacity: 0.6; cursor: not-allowed; }

.summary-bar { display: flex; align-items: center; gap: 10px; padding-bottom: 20px; flex-wrap: wrap; }
.summary-pill { display: inline-flex; align-items: center; gap: 7px; padding: 8px 12px; border: 1px solid var(--border); border-radius: 20px; color: var(--muted-foreground); background: var(--card); font-size: 12px; }
.summary-pill strong { color: var(--foreground); font-weight: 600; }
.summary-pill svg { color: var(--destructive); }
.summary-success svg { color: var(--success); }
.summary-blocked svg { color: var(--warning); }
.summary-tokens svg { color: var(--ai); }

.error-list-section { width: 100%; max-width: 960px; margin: auto; }
.list-toolbar { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; }
.searchbox { height: 38px; flex: 1; border: 1px solid var(--border); border-radius: 5px; background: var(--card); display: flex; align-items: center; gap: 8px; padding: 0 10px; color: var(--muted-foreground); }
.searchbox input { background: transparent; outline: none; border: 0; width: 100%; font-size: 11px; color: var(--foreground); }
.feed-filters { display: flex; gap: 4px; flex-wrap: wrap; }
.filter { height: 32px; font-size: 11px; padding: 5px 10px; border-radius: 6px; color: var(--muted-foreground); display: inline-flex; align-items: center; gap: 5px; }
.filter:hover { background: var(--accent); }
.filter.active { background: var(--secondary); color: var(--foreground); }

.error-list { display: grid; gap: 12px; }
.error-card { border: 1px solid var(--border); border-radius: 8px; background: var(--card); overflow: hidden; animation: enter .25s ease-out; }
.error-card[data-state=open] { border-color: color-mix(in oklab, var(--primary) 20%, var(--border)); }
@keyframes enter { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
.new-error-card { animation: new-error .7s ease-out; }
@keyframes new-error { from { transform: translateY(-16px); opacity: 0; box-shadow: 0 0 0 2px var(--warning), 0 0 20px color-mix(in oklab, var(--success) 25%, transparent); } to { transform: translateY(0); opacity: 1; box-shadow: 0 0 0 0 transparent; } }
.error-row { width: 100%; display: flex; padding: 18px 22px; gap: 16px; text-align: left; align-items: flex-start; }
.error-row:hover { background: var(--accent); }
.error-row:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
.error-row-content { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px; min-width: 0; flex: 1; }
.error-row-title { flex-basis: 100%; font-size: 16px; font-weight: 600; line-height: 1.5; }
.error-row-preview { display: flex; align-items: center; gap: 10px; flex-basis: 100%; min-width: 0; font: 12px/1.6 var(--font-mono); color: var(--secondary-foreground); }
.error-row-preview > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.occurrences { flex-shrink: 0; background: var(--secondary); padding: 1px 7px; border-radius: 4px; color: var(--foreground); }
.error-row-meta { display: flex; align-items: center; gap: 18px; flex-basis: 100%; font-size: 12px; color: var(--secondary-foreground); }
.error-row-meta > span { display: flex; align-items: center; gap: 5px; }
.error-row-meta > span:first-child { font-family: var(--font-mono); }
.error-row-meta time { margin-left: auto; }
.chevron { color: var(--muted-foreground); transition: transform .2s ease; margin-top: 4px; flex-shrink: 0; }
.chevron[data-open=true] { transform: rotate(180deg); }

.status-badge { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 550; padding: 4px 7px; border-radius: 4px; background: color-mix(in oklab, var(--muted-foreground) 10%, transparent); color: var(--muted-foreground); }
.tone-verified { color: var(--success); background: color-mix(in oklab, var(--success) 10%, transparent); }
.tone-running { color: var(--warning); background: color-mix(in oklab, var(--warning) 9%, transparent); }
.tone-failed { color: var(--destructive); background: color-mix(in oklab, var(--destructive) 9%, transparent); }

.row-metrics { display: flex; align-items: center; gap: 12px; margin-left: auto; flex-wrap: wrap; font-size: 11px; font-weight: 500; }
.confidence-meter { display: inline-flex; align-items: center; gap: 7px; }
.confidence-high { color: var(--success); }
.confidence-medium { color: var(--warning); }
.confidence-low { color: var(--destructive); }
.confidence-unknown { color: var(--secondary-foreground); }
.confidence-track { width: 40px; height: 4px; border-radius: 4px; background: var(--secondary); overflow: hidden; }
.confidence-track svg { width: 100%; height: 100%; display: block; }
.fix-metric { display: inline-flex; gap: 4px; align-items: center; color: var(--secondary-foreground); }

.inspector { min-width: 0; border-top: 1px solid var(--border); }
.inspector-actions { display: flex; align-items: center; justify-content: flex-end; padding: 15px 24px 0; }
.pr-button { display: inline-flex; align-items: center; gap: 6px; background: var(--primary); color: var(--primary-foreground); border-radius: 6px; padding: 8px 13px; font-size: 12px; font-weight: 600; }
.pr-button:hover { opacity: .9; }
.pr-button-outline { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--input); border-radius: 6px; padding: 7px 11px; font-size: 12px; color: var(--foreground); }
.pr-button-outline:hover { background: var(--accent); }
.simple-body { padding: 22px 24px 24px; }

.guardrail-banner { display: flex; align-items: center; gap: 12px; padding: 14px 0 18px; margin-bottom: 20px; border-bottom: 2px solid var(--destructive); color: var(--destructive); }
.guardrail-banner > svg { flex-shrink: 0; }
.guardrail-banner div { flex: 1; }
.guardrail-banner strong { font-size: 15px; line-height: 1.6; }
.guardrail-banner p { color: var(--secondary-foreground); font-size: 12px; line-height: 1.6; margin: 5px 0 0; }

.simple-proof { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; padding: 4px 0; }
.proof-step { position: relative; min-width: 0; text-align: center; }
.proof-step::after { content: ''; position: absolute; top: 26px; left: calc(50% + 33px); width: calc(100% - 54px); height: 1px; background: var(--border); }
.proof-step:last-child::after { display: none; }
.proof-complete::after { background: color-mix(in oklab, var(--success) 40%, var(--border)); }
.proof-reproduced::after { background: color-mix(in oklab, var(--destructive) 40%, var(--border)); }
.proof-node { width: 52px; height: 52px; border-radius: 50%; border: 1px solid var(--border); background: var(--background); display: grid; place-items: center; position: relative; margin: 0 auto; color: var(--muted-foreground); }
.proof-step h3 { font-size: 15px; font-weight: 600; line-height: 1.7; margin: 10px 0 3px; }
.proof-step p { color: var(--secondary-foreground); font-size: 15px; line-height: 1.45; min-height: 44px; }
.proof-diagnosed .proof-node { color: var(--ai); border-color: color-mix(in oklab, var(--ai) 30%, var(--border)); background: color-mix(in oklab, var(--ai) 6%, var(--background)); }
.proof-reproduced .proof-node, .proof-blocked .proof-node { color: var(--destructive); border-color: color-mix(in oklab, var(--destructive) 30%, var(--border)); background: color-mix(in oklab, var(--destructive) 6%, var(--background)); }
.proof-resolved .proof-node { color: var(--success); border-color: color-mix(in oklab, var(--success) 30%, var(--border)); background: color-mix(in oklab, var(--success) 6%, var(--background)); }
.proof-check { position: absolute; top: -3px; right: -3px; width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; background: var(--success); color: var(--primary-foreground); border: 2px solid var(--card); }
.proof-reproduced .proof-check { background: var(--destructive); color: var(--destructive-foreground); }
.border-spinner { position: absolute; inset: -1px; border: 2px solid transparent; border-top-color: var(--warning); border-right-color: var(--warning); border-radius: 50%; animation: border-spinner 1.2s linear infinite; }
@keyframes border-spinner { to { transform: rotate(360deg); } }
.step-evidence { display: flex; align-items: center; justify-content: center; gap: 5px; flex-wrap: wrap; min-height: 28px; margin-top: 5px; }
.sha-pill, .duration-pill, .running-timer { display: inline-flex; align-items: center; gap: 4px; padding: 3px 6px; border-radius: 4px; background: var(--secondary); color: var(--secondary-foreground); font: 11px/1.5 var(--font-mono); }
.running-timer { color: var(--warning); }
.timer-pulse { width: 6px; height: 6px; border-radius: 50%; border: 1px solid var(--warning); animation: timer-pulse 1.4s ease-in-out infinite; }
@keyframes timer-pulse { 50% { box-shadow: 0 0 0 4px color-mix(in oklab, var(--warning) 20%, transparent); } }
.ci-run-link { display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 4px 8px; margin: 5px auto 0; border: 1px solid currentColor; border-radius: 4px; font-size: 12px; }
.ci-red { color: var(--destructive); }
.ci-green { color: var(--success); }
.run-unavailable { display: block; font-size: 11px; color: var(--secondary-foreground); margin-top: 6px; }

.plain-summary { padding: 22px 0 20px; }
.plain-summary h3, .diff-heading h3 { font-size: 16px; font-weight: 600; margin: 0 0 14px; }
.explanation-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
.explanation-grid h4 { font-size: 14px; font-weight: 550; margin: 0 0 6px; }
.explanation-grid p { font-size: 15px; line-height: 1.7; color: var(--secondary-foreground); white-space: pre-wrap; }

.diff-heading { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.diff-heading > span { display: flex; align-items: center; gap: 5px; font-size: 10px; color: var(--success); margin-bottom: 14px; }
.unified-editor { border: 1px solid var(--border); border-radius: 6px; overflow: hidden; margin-bottom: 12px; background: var(--background); }
.editor-tabs { display: flex; border-bottom: 1px solid var(--border); background: var(--muted); flex-wrap: wrap; }
.editor-file-tab { display: flex; align-items: center; gap: 7px; font-family: var(--font-mono); font-size: 11px; padding: 10px 12px; border-right: 1px solid var(--border); border-top: 2px solid transparent; background: var(--muted); color: var(--secondary-foreground); overflow-wrap: anywhere; }
.editor-file-tab svg { color: var(--ai); }
.editor-file-tab[data-state=active] { border-top-color: var(--ai); background: var(--background); color: var(--foreground); }
.editor-code { padding: 10px 0; font-family: var(--font-mono); font-size: 13px; line-height: 2.1; }
.editor-row { display: grid; grid-template-columns: 24px 32px minmax(0, 1fr); padding: 0 12px; min-height: 28px; }
.diff-marker { text-align: center; color: var(--muted-foreground); user-select: none; }
.editor-line-number { text-align: right; padding-right: 12px; color: var(--muted-foreground); border-right: 1px solid var(--border); user-select: none; }
.editor-row code { white-space: pre-wrap; overflow-wrap: anywhere; padding-left: 14px; font: inherit; }
.editor-removed { background: color-mix(in oklab, var(--destructive) 12%, var(--background)); color: var(--destructive); }
.editor-added { background: color-mix(in oklab, var(--success) 12%, var(--background)); color: var(--success); }
.editor-removed .diff-marker { color: var(--destructive); }
.editor-added .diff-marker { color: var(--success); }
.generated-test { max-height: 280px; overflow: auto; }
.blocked-explanation { display: flex; align-items: center; gap: 8px; padding: 16px; color: var(--secondary-foreground); font-size: 15px; }

.evidence-accordion { margin-top: 8px; border-top: 1px solid var(--border); }
.evidence-accordion > button { display: flex; width: 100%; justify-content: space-between; align-items: center; padding: 14px 0; font-size: 13px; color: var(--secondary-foreground); }
.evidence-accordion pre { padding: 12px; font-family: var(--font-mono); font-size: 12px; line-height: 1.9; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--background); border: 1px solid var(--border); border-radius: 5px; max-height: 250px; overflow: auto; color: var(--secondary-foreground); }

.app-footer { display: flex; justify-content: space-between; padding: 16px 0 20px; font-size: 10px; color: var(--muted-foreground); }
.footer-left { display: flex; gap: 18px; align-items: center; }
.footer-right { display: flex; align-items: center; gap: 6px; }

.fx-overlay { position: fixed; inset: 0; z-index: 50; display: grid; place-items: center; background: oklch(0.1 0.01 275 / 80%); padding: 16px; }
.fx-dialog { width: 100%; max-width: 480px; max-height: 90vh; overflow-y: auto; background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 20px; display: grid; gap: 16px; }
.fx-dialog h2 { font-size: 16px; font-weight: 650; }
.fx-dialog > header p { color: var(--muted-foreground); font-size: 12px; margin-top: 4px; }
.settings-section { border-top: 1px solid var(--border); padding-top: 17px; display: grid; gap: 12px; }
.settings-section h3 { display: flex; gap: 7px; align-items: center; font-size: 12px; font-weight: 600; }
.settings-section label { font-size: 11px; color: var(--muted-foreground); }
.settings-section input, .settings-section select { width: 100%; border: 1px solid var(--input); border-radius: 5px; background: var(--background); padding: 9px; color: var(--foreground); outline: none; }
.settings-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.settings-info { color: var(--muted-foreground); font-size: 10px; line-height: 1.8; display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }

.toast-stack { position: fixed; right: 16px; bottom: 16px; z-index: 60; display: grid; gap: 8px; max-width: 320px; }
.toast { border: 1px solid var(--border); background: var(--card); border-radius: 8px; padding: 10px 13px; font-size: 12px; animation: enter .2s ease-out; }
.toast-success { border-color: color-mix(in oklab, var(--success) 35%, var(--border)); color: var(--success); }
.toast-warning { border-color: color-mix(in oklab, var(--warning) 35%, var(--border)); color: var(--warning); }

.empty-note { color: var(--muted-foreground); font-size: 12px; text-align: center; padding: 40px 0; }
.waiting-state { border: 1px dashed var(--border); border-radius: 8px; background: var(--card); padding: 36px 24px; text-align: center; display: grid; justify-items: center; gap: 10px; }
.waiting-state h2 { font-size: 15px; font-weight: 600; color: var(--foreground); }
.waiting-state p { color: var(--muted-foreground); font-size: 12px; max-width: 520px; line-height: 1.6; }
.waiting-actions { display: flex; align-items: center; gap: 10px; margin-top: 6px; flex-wrap: wrap; justify-content: center; }
.sample-banner { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; padding: 10px 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--card); color: var(--muted-foreground); font-size: 11px; flex-wrap: wrap; }
.spin { animation: border-spinner 1s linear infinite; }

@media (max-width: 1100px) { .fx .brand-tag { display: none; } .fx .topbar { padding: 0 22px; } }
@media (max-width: 760px) {
  .fx .topbar { padding: 0 16px; } .fx .repo-owner, .fx .avatar { display: none; } .fx .top-actions { gap: 5px; }
  .fx .dashboard { padding: 20px 16px 0; } .fx .page-heading { align-items: flex-start; } .fx .page-heading h1 { font-size: 22px; }
  .fx .live-status, .fx .simulate-label { display: none; }
  .fx .summary-pill { font-size: 10px; padding: 6px 8px; }
  .fx .list-toolbar { flex-direction: column; align-items: stretch; gap: 10px; }
  .fx .error-row { padding: 15px; } .fx .error-row-title { font-size: 15px; }
  .fx .row-metrics { margin-left: 0; gap: 8px; }
  .fx .simple-body { padding: 16px 15px; } .fx .inspector-actions { padding: 14px 15px 0; }
  .fx .simple-proof { gap: 6px; } .fx .proof-step h3 { font-size: 12px; min-height: 36px; } .fx .proof-step p { font-size: 12px; min-height: 54px; }
  .fx .editor-code { font-size: 11px; } .fx .editor-row { padding: 0 6px; grid-template-columns: 18px 25px minmax(0, 1fr); }
  .fx .explanation-grid { grid-template-columns: 1fr; gap: 14px; }
}
@media (prefers-reduced-motion: reduce) { .fx *, .fx *::before, .fx *::after { animation: none !important; transition: none !important; } }
`;

export function DashboardTheme() {
  return <style>{CSS}</style>;
}
