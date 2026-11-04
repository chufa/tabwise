export const ALARM_NAME = "tabwise-idle-check";
export const ALARM_PERIOD_MINUTES = 1;
export const CHECKPOINT_ALARM_NAME = "tabwise-checkpoint";
export const CHECKPOINT_PERIOD_MINUTES = 30;
export const SUSPENDED_PAGE = "src/suspended/suspended.html";
export const SCHEMA_VERSION = 1;
export const DEFAULT_SETTINGS = Object.freeze({
  idleMinutes: 30,
  autoSuspend: false,
  suspensionMode: "conservative",
  suspensionStrategy: "placeholder",
  semanticSearch: false,
  resourceSampling: false,
  trustedDomains: [],
  blockedDomains: [],
  pauseUntil: 0
});

export const SUSPENSION_MODES = Object.freeze({
  CONSERVATIVE: "conservative",
  SMART: "smart"
});

export const SUSPENSION_STRATEGIES = Object.freeze({
  PLACEHOLDER: "placeholder",
  NATIVE_DISCARD: "native-discard"
});

export const SUSPENSION_STATES = Object.freeze({
  SUSPENDING: "suspending",
  SUSPENDED: "suspended",
  RESTORING: "restoring",
  ERROR: "error"
});
