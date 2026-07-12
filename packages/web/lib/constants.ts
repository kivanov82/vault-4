// Strategy epoch start — the UI presents the track record from this instant
// (2026-07-09: the strategy overhaul's first clean rounds; matches the
// backend's METRICS_EPOCH_START). Header uptime, the PnL chart window, and
// the history tab are all anchored here. Earlier eras (manual trading,
// pre-overhaul strategy) remain in the API's lifetime metrics but are not
// part of the displayed track record.
export const LAUNCH_DATE_ISO = "2026-07-09T00:00:00Z"
export const LAUNCH_DATE_MS = new Date(LAUNCH_DATE_ISO).getTime()
