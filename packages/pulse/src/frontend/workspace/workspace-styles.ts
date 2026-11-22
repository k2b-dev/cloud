/** Pulse's sidebar identity; on a phone the host's title with the base switcher takes the sidebar's place. */
export const pulseWorkspaceStyles = `
.pulse-sidebar__identity{flex:none;padding:16px 12px 8px;font-size:16px;font-weight:600}
@container k2b-app-area (max-width:767px){
  .k2b-ui .pulse-workspace{height:auto;flex:1;min-height:0}
}
`;
