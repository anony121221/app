export const invoke = window.__TAURI__.core.invoke;
export const listen = window.__TAURI__.event.listen;

let _l3TransportWarmed = false;

export function warmL3TransportOnce() {
  if (_l3TransportWarmed) return;
  _l3TransportWarmed = true;
  // Warm IPC + DNS + TLS to the L3 bucket before first station click.
  invoke('l3_list_page', { prefix: 'KTLX_', maxKeys: 1 }).catch(() => {});
}
