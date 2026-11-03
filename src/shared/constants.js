export const ALARM_NAME = "tabwise-idle-check";
export const ALARM_PERIOD_MINUTES = 1;
export const SUSPENDED_PAGE = "src/suspended/suspended.html";
export const SCHEMA_VERSION = 1;
export const DEFAULT_SETTINGS = Object.freeze({
  idleMinutes: 30,
  autoSuspend: false,
  trustedDomains: [],
  blockedDomains: [],
  pauseUntil: 0
});

export const SUSPENSION_STATES = Object.freeze({
  SUSPENDING: "suspending",
  SUSPENDED: "suspended",
  RESTORING: "restoring",
  ERROR: "error"
});
