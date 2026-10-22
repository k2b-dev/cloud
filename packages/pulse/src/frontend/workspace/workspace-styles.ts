/** Pulse's phone composition: base and title, object chips, then the shared main surface. */
export const pulseWorkspaceStyles = `
.pulse-workspace__mobile-header{display:none}
.pulse-sidebar__identity{flex:none;padding:16px 12px 8px;font-size:16px;font-weight:600}
@container k2b-app-area (max-width:767px){
  .k2b-ui .pulse-workspace{height:auto;flex:1;min-height:0}
  .pulse-workspace__mobile-header{display:block;flex:none;padding:4px 16px 0}
  .pulse-workspace__base-switcher{width:fit-content}
  .pulse-workspace__mobile-header .k2b-sidebar-switcher__trigger{min-height:34px;padding:0;gap:8px}
  .pulse-workspace__mobile-header .k2b-sidebar-switcher__copy{min-height:0}
  .pulse-workspace__mobile-title{display:flex;align-items:center;gap:8px}
  .pulse-workspace__mobile-title>p{flex:1;min-width:0;font-size:30px;line-height:1.2;font-weight:600;letter-spacing:-.025em;overflow-wrap:anywhere}
  .pulse-workspace .pulse-sidebar__secondary,.pulse-workspace .pulse-sidebar__identity{display:none!important}
  .pulse-workspace__desktop-action{display:none!important}
  .pulse-workspace .pulse-sidebar__chip{padding-inline:8px!important;gap:6px!important;border-radius:12px!important}
  .pulse-workspace .pulse-overview__assistant-desktop{display:none}
  .pulse-workspace .pulse-overview__toolbar{min-height:0;gap:0}
  .pulse-workspace .pulse-overview__assistant-feedback:empty{display:none}
  .pulse-workspace .k2b-app-workspace__sidebar[data-mobile=stacked]>.k2b-app-workspace__sidebar-all{width:32px;min-width:32px;padding:0;justify-content:center}
  .pulse-workspace .k2b-app-workspace__sidebar[data-mobile=stacked]>.k2b-app-workspace__sidebar-all>span{display:none}

}
`;
