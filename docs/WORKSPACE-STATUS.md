# Workspace connection status dots

> Since 1.6.1. Applies to the grouped/tree sidebar view of DSH 0.2.x.

## What it does

Each remote workspace row gets a 7px status dot at the lower-right corner of the
folder icon:

| State | Visual | Meaning |
| --- | --- | --- |
| `connected` | solid green | SSH is connected; files and commands use the host |
| `connecting` | amber ring with a gap, rotating | connecting or reconnecting |
| `disconnected` | hollow gray ring | not connected; the workspace remains visible |
| `error` | red with a white slash | authentication/network/host-key failure |

The dot is **additive**: it does not change the folder colour (DSH reserves blue for
the currently open workspace), the workspace title, or row height. Local workspaces
have no dot.

## Data flow

1. The host adds `workspaceId` to each `GET /state.workspaces[]` row, matching the
   workspace registry by canonical path (`realpath`), so a `$DSH_HOME` junction or a
   moved home does not break the mapping. Realpath lookups are cached for 30s and
   cleared on workspace create/remove, so the 8s `/state` refresh does not repeatedly
   block the host on filesystem calls.
2. The client maps `workspaceId` → connection state. It falls back to the older
   `stub`/`path` comparison only when the host does not send the field.
3. The client generates one `<style data-rd-ws-status>` with selectors keyed by
   `data-row-key="workspace:<id>"`. No DOM nodes are inserted and React is not touched.
4. Status updates on `/state` refresh (8s), after connection actions, and when the page
   becomes visible or regains focus.
5. Status generation is best-effort: any DOM/style failure is caught and only logged in
   debug mode, so the status layer can never break the rest of the plugin UI.

## Why CSS and not a slot

DSH 0.2.2-rc.3's `ui-workspace` exposes Session-row seats but no workspace-row slot.
The workspace row's internal `data-row-key` is the only stable per-row anchor. The CSS
bridge is deliberately a bridge, not an official extension point:

- if a future DSH release changes the row attribute, the dots disappear and nothing else
  breaks;
- the stylesheet is always injected; no row simply means no-op, so rail/flat/search do
  not disable the feature;
- `DSH_REMOTE_DECK_WORKSPACE_STATUS=0` is a runtime kill switch.

Long term, an upstream `sidebar.workspaces.workspace.row.leading` slot would replace
this bridge.

## Limits

- Flat list, collapsed rail, and search results have no workspace rows; use the Session
  badge / SSH chip there.
- CSS pseudo-elements are not in the accessibility tree. The SSH chip has an aggregated
  `aria-label`, and Session badges carry the state in their title.
- The dot depends on internal DSH DOM. Update `docs/DSH-COMPATIBILITY.md` when DSH is
  upgraded and re-run the smoke check.
