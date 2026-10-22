/** Dashboard-owned composition; shared controls and charts retain their UI contracts. */
export const dashboardStyles = `
.pulse-dashboard{container-type:inline-size;width:100%;min-width:0;color:var(--k2b-text);font-size:14px;line-height:1.45}
.pulse-dashboard__toolbar{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;min-height:64px}
.pulse-dashboard__actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.pulse-dashboard__band{display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-height:40px;margin:6px 0 10px;color:var(--k2b-text-muted);font-size:13px}
.pulse-dashboard__band[data-error=true]{color:var(--k2b-danger-text)}
.pulse-dashboard__band strong{color:var(--k2b-text);font-weight:600}
.pulse-dashboard__band[data-attention=true]>i{color:var(--k2b-warning-text)}
.pulse-dashboard__band[data-critical=true]>i,.pulse-dashboard__band[data-error=true] strong{color:var(--k2b-danger-text)}
.pulse-dashboard__stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px 28px}
.pulse-dashboard__stats>.pulse-dashboard__panel{grid-column:auto}
.pulse-dashboard__stats .k2b-stat-cell{padding:0;background:transparent;border:0;min-width:0}
.pulse-dashboard__stats .pulse-dashboard__feedback{min-height:106px;margin-top:0;padding-top:24px}
.pulse-dashboard__number-placeholder-title{position:absolute;top:0;left:0;padding-right:32px;font-size:13px;font-weight:500;color:var(--k2b-text-muted)}
.pulse-dashboard__stats .k2b-stat-cell{min-height:72px}
.pulse-dashboard__number[data-tone=success] .k2b-stat-cell__sub{color:var(--k2b-success-text)}
.pulse-dashboard__number[data-tone=warning] .k2b-stat-cell__sub{color:var(--k2b-warning-text)}
.pulse-dashboard__number[data-tone=danger] .k2b-stat-cell__sub{color:var(--k2b-danger-text)}
.pulse-dashboard__number .k2b-chart{color:var(--stdlib-chart-c1)}
.pulse-dashboard__stats [data-panel]:nth-child(2) .k2b-chart{color:var(--stdlib-chart-c2)}
.pulse-dashboard__stats [data-panel]:nth-child(3) .k2b-chart{color:var(--stdlib-chart-c3)}
.pulse-dashboard__stats [data-panel]:nth-child(4) .k2b-chart{color:var(--stdlib-chart-c4)}
.pulse-dashboard__stats .k2b-stat-cell__label{padding-right:32px}
.pulse-dashboard__number-sql{position:absolute;top:0;right:0}
.pulse-dashboard__stats .k2b-stat-cell__value{font-size:28px;line-height:1.2;letter-spacing:-.02em}
.pulse-dashboard__section{margin-top:30px;min-width:0}
.pulse-dashboard__section-heading{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.pulse-dashboard__section-heading h2{min-width:0;overflow-wrap:anywhere;font-size:16px;font-weight:600}
.pulse-dashboard__section-description{min-width:0;overflow-wrap:anywhere;margin-left:auto;color:var(--k2b-text-muted);font-size:12.5px}
@container k2b-app-area (min-width:1024px){.pulse-dashboard__heading{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}}
@container k2b-app-area (max-width:1023px){.pulse-dashboard__heading h1{font-size:30px;letter-spacing:-.025em}}
@container(max-width:600px){.pulse-dashboard__section-description{display:none}}
.pulse-dashboard__panels{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:26px 32px}
.pulse-dashboard__panel{position:relative;min-width:0;grid-column:span 2}
.pulse-dashboard__panel[data-width=half]{grid-column:span 3}
.pulse-dashboard__panel[data-width=full]{grid-column:span 6}
.pulse-dashboard__panel-head{display:flex;align-items:center;justify-content:space-between;gap:6px;min-height:28px;font-weight:600}
.pulse-dashboard__panel-head h3{min-width:0;overflow-wrap:anywhere}
.pulse-dashboard__description{overflow-wrap:anywhere;color:var(--k2b-text-muted);font-size:12.5px;min-height:18px}
.pulse-dashboard__plot{height:198px;min-width:0;margin-top:6px}
.pulse-dashboard__plot .k2b-chart{height:100%}
.pulse-dashboard__feedback{display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:8px;min-height:198px;margin-top:6px}
.pulse-dashboard__empty{display:flex;flex-direction:column;align-items:flex-start;gap:10px;max-width:520px;padding:40px 0 20px}
.pulse-dashboard__empty h2{font-size:20px;font-weight:600}
.pulse-dashboard__empty p{color:var(--k2b-text-muted)}
.pulse-dashboard__custom{display:flex;flex-wrap:wrap;align-items:end;gap:12px;padding:12px 0}
.pulse-dashboard__sql{margin-top:10px;font-weight:400}
.pulse-dashboard__sql pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}
.pulse-dashboard__table{min-width:0;margin-top:6px;max-height:360px;overflow:auto}
.pulse-dashboard__public{width:100%;max-width:1600px;margin:0 auto;padding:24px}
@container(max-width:1000px){.pulse-dashboard__panel{grid-column:span 3}.pulse-dashboard__panel[data-width=full]{grid-column:span 6}}
@container(max-width:600px){.pulse-dashboard__stats{grid-template-columns:repeat(2,minmax(0,1fr));gap:18px 20px}.pulse-dashboard__stats .k2b-stat-cell__value{font-size:24px}.pulse-dashboard__panels{grid-template-columns:minmax(0,1fr);gap:26px}.pulse-dashboard__panel,.pulse-dashboard__panel[data-width=half],.pulse-dashboard__panel[data-width=full]{grid-column:span 1}.pulse-dashboard__toolbar{align-items:flex-start}.pulse-dashboard__public{padding:16px}}
@media(max-width:600px){.pulse-dashboard__public{padding:16px}}
`;
