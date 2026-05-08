export type {
  Game,
  Chapter,
  GameEvent,
  SpoilerEntity,
  SpoilerCategory,
  SpoilerLevel,
  ProgressModel,
} from "./types/game.js";

export type {
  ChatMessage,
  FilterResult,
  FilterVerdict,
  FilterMode,
  UserProgress,
} from "./types/chat.js";

export type {
  JudgeRequest,
  JudgeResponse,
  Result,
} from "./types/api.js";

export type { MisreportEntry } from "./types/misreport.js";

export type {
  CollectionLabel,
  StageACategory,
  JudgmentMode,
  LabelSource,
  JudgmentStage,
  TargetMessagePayload,
  ContextMessage,
  UserFeedbackPayload,
  SpoilerJudgmentLog,
  ConsentRecord,
  IngestRequestPayload,
  IngestResponsePayload,
  ConsentVersionMismatchResponse,
  RevokeRequestPayload,
  RevokeResponsePayload,
  ConsentNotifyRequestPayload,
  ConsentNotifyResponsePayload,
} from "./types/collection.js";

export type {
  FilterSettings,
  FilterSettingsV1,
  GameContext,
} from "./types/settings.js";

export type {
  BgFetchEndpoint,
  BackgroundFetchRequest,
  BackgroundFetchResponse,
} from "./types/background-messaging.js";

export { migrateSettings } from "./settings-migration.js";

export { ok, err } from "./types/api.js";

export { SPOILER_VERBS, matchesSpoilerVerb } from "./spoilerContext.js";

export { normalizeKana } from "./normalizeKana.js";
