export const ALARM_NAME = "tabwise-idle-check";
export const ALARM_PERIOD_MINUTES = 1;
export const CHECKPOINT_ALARM_NAME = "tabwise-checkpoint";
export const CHECKPOINT_PERIOD_MINUTES = 30;
export const RESOURCE_REVIEW_ALARM_NAME = "tabwise-resource-review";
export const SUSPENDED_PAGE = "src/suspended/suspended.html";
export const SCHEMA_VERSION = 1;
export const DEFAULT_SETTINGS = Object.freeze({
  idleMinutes: 30,
  siteIdleRules: [],
  workspaceFilters: [],
  backupReminderDays: 0,
  autoSuspend: false,
  suspensionMode: "conservative",
  suspensionStrategy: "placeholder",
  semanticSearch: false,
  aiProvider: "browser",
  ollamaEndpoint: "",
  ollamaModel: "",
  compatibleEndpoint: "",
  compatibleModel: "",
  compatibleJson: true,
  scheduledReviewEnabled: false,
  scheduledReviewHour: 18,
  scheduledReviewMinute: 0,
  scheduledArchiveEnabled: false,
  scheduledArchiveDays: 30,
  resourceSampling: true,
  resourceSamplingMode: "normal",
  resourceBudgetEnabled: false,
  resourceBudgetTabs: 50,
  resourceBudgetHeapMB: 1024,
  closedHistoryEnabled: true,
  closedHistoryDays: 7,
  browserHistorySearchEnabled: false,
  bookmarkSearchEnabled: false,
  historyExcludedDomains: [],
  trustedDomains: [],
  blockedDomains: [],
  manualDomains: [],
  nativeDiscardDomains: [],
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
