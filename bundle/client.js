/* 08 local workbench client module (UI-04/05) for DeepSeek Harness 0.2.1-rc.5.
Native rc.5 bundle; only require('react') is used (React.createElement, no JSX build step). */
window.__ModuleLoader__.load({
id: '@local/dsh-workbench-ui',
factory: function (require) {
'use strict';

var module = {exports: {}};
var exports = module.exports;

var React = require('react');
var createElement = React.createElement;
var Fragment = React.Fragment;
var useState = React.useState;
var useEffect = React.useEffect;
var useRef = React.useRef;
var el = createElement;
var assign = Object.assign;
var hasOwn = function (target, key) {
return Object.prototype.hasOwnProperty.call(target, key);
};

var PLUGIN_NAME = 'local-workbench';
var PANEL_KEY = 'local-workbench';
var PANEL_LABEL = '本地工作台';
var CHANNEL = '/local-workbench';
var SCHEMA_VERSION = 1;
var BOOTSTRAP_CONTEXT_REF = 'bootstrap';
var POLL_INTERVAL_MS = 1000;
var MAX_DEDUPE_INTENTS = 32;
var COPY_FEEDBACK_MS = 2500;
var MAX_LIST = 64;

var TEXT = {
transportFailure: '无法连接 Host，请稍后重试。',
protocolFailure: '工作台返回了无法识别的响应。',
genericFailure: '操作未完成，请稍后重试。',
noContext: '没有已登记的工作台上下文',
noContextHint: '请先在 Host 中登记一个项目上下文，然后点击“重新检查”。',
retry: '重新检查',
retryStatus: '重试',
discovering: '正在读取工作台上下文…',
refreshing: '正在刷新工作台上下文…',
choosing: '检测到多个工作台上下文，请选择一个：',
choosingTitle: '选择工作台上下文',
modulesTitle: '已接入模块',
modulesEmpty: '当前上下文尚未选择任何模块。',
modulesLoading: '正在读取模块状态…',
issuesTitle: '需处理',
issuesEmpty: '暂无需要处理的项目。',
laterTitle: '后续接入',
laterEmpty: '已知模块都已经接入上方列表。',
laterHint: '尚未接入，仅展示占位，不可操作。',
compositionTitle: '组合诊断',
compositionCheck: '检查组合',
compositionCollapse: '收起组合检查',
compositionHint: '这里的勾选只在本地生成只读差异预览，不写入组合。',
compositionBusy: '正在生成组合预览…',
compositionApplyNote: '应用组合需通过 Host 管理入口并重启后生效；工作台不直接写入组合。',
compositionRevision: '当前组合 revision：',
previewDigest: '预览摘要：',
busyPreparing: '正在准备…',
enter: '进入',
returnChat: '返回聊天',
returned: '已返回聊天。',
opened: '已打开',
contextLabel: '当前上下文：',
sessionLabel: '会话：',
notBound: '未绑定',
compositionRevisionLabel: '组合 revision：',
updatedAt: '更新于 ',
unknownTime: '未知时间',
copy: '复制指令',
copyOk: '已复制',
copyFailed: '复制失败，请手动选择文本复制',
closeInstruction: '关闭说明',
instructionTitle: '手动打开说明',
instructionKindSkill: 'skill 入口',
instructionKindCommand: 'host_command 入口',
instructionRef: '指令引用：',
instructionKey: '指令键：',
instructionModule: '所属模块：',
instructionFallback: '该入口需要按所属能力的说明手动打开；未登记可读指令文案。',
instructionSafety: '工作台只展示说明，不会把指令发送到聊天，也不会自动执行 shell。',
liveIdle: '工作台已连接。',
liveRefreshed: '状态已更新。',
about: '工作范围仅限当前上下文；底层成功由所属模块决定。',
intentInvalid: 'Host 返回的导航意图与当前请求不一致，已取消打开。',
staleScope: '当前范围已变化，导航意图已失效，请刷新后重试。',
staleRevision: '上下文版本已变化，导航意图已失效，请刷新后重试。',
expiredIntent: '导航意图已过期，请重新进入。',
digestMismatch: '组合摘要不一致，已取消打开，请刷新后重试。',
targetUnregistered: '目标面板尚未注册，暂时无法打开。',
operationPrefix: '操作 ',
outcomeUnknown: '结果待核实',
reasonPrefix: '原因：',
modulePrefix: '模块 ',
generationPrefix: '代次 ',
revisionPrefix: '修订 ',
severityError: '错误',
severityWarning: '警告',
severityInfo: '提示',
fixtureBanner: 'fixture 组合（非真实能力）',
contextSwitch: '切换上下文：',
contextNavLabel: '工作台上下文',
diffAdded: '新增：',
diffRemoved: '移除：',
diffChanged: '变更：',
diffUnchanged: '未变化：',
diffNone: '无',
previewPrefix: '预览 ',
digestPrefix: '摘要 ',
attentionState: '需处理',
blockedState: '阻断',
operationUnknownText: '结果待核实',
};

var MODULE_LABELS = {
'01': '浏览器认证',
'02': '远端环境',
'03': '会话回退',
'04': '学习编排',
'05': '本地记忆',
'06': '本地图示',
'07': '上下文观察',
};

var KNOWN_LATER_MODULES = ['05', '07'];

var STATE_TEXT = {
ready: '可用',
busy: '忙碌',
attention: '需处理',
disabled: '停用',
blocked: '阻断',
unavailable: '不可用',
};

var ENTRY_DISABLED_TEXT = {
busy: '模块正在处理其他操作，请稍后再试。',
disabled: '模块已停用，无法进入。',
blocked: '模块被阻断，无法进入。',
unavailable: '模块不可用，无法进入。',
};

var OPERATION_STATE_TEXT = {
queued: '排队中',
running: '进行中',
cancelling: '取消中',
outcome_unknown: '结果待核实',
};

var REASON_TEXT = {
OWNER_REQUIRED: '需要所有者身份才能操作。',
CONTEXT_UNBOUND: '当前面板没有绑定工作台上下文。',
SCOPE_REVOKED: '当前项目范围已被撤销。',
PROFILE_DENIED: '当前配置组合未授权该操作。',
MODULE_DENIED: '所属模块拒绝了该操作。',
STALE_SCOPE: '范围已变化，请刷新后重试。',
STALE_REVISION: '状态版本已变化，请刷新后重试。',
STALE_PREVIEW: '组合预览已过期，请重新生成。',
UNKNOWN_ENDPOINT: '工作台接口不可用。',
LIMIT_EXCEEDED: '请求超出允许的大小限制。',
INTERNAL_FAILURE: 'Host 内部处理失败。',
TRANSPORT_FAILURE: '无法连接 Host，请稍后重试。',
INVALID_REQUEST: '请求格式无效。',
EXPIRED_INTENT: '导航意图已过期，请重新进入。',
TARGET_UNREGISTERED: '目标面板尚未注册，暂时无法打开。',
MODULE_BUSY: '模块正在处理其他操作，请稍后再试。',
NOT_READY: '模块尚未就绪。',
DIGEST_MISMATCH: '组合摘要不一致，请刷新后重试。',
UNKNOWN_MODULE: '未知模块。',
DEPENDENCY_MISSING: '缺少依赖模块或服务。',
DEPENDENCY_CYCLE: '模块依赖存在环。',
TOOL_CONFLICT: '工具命名冲突。',
SLOT_CONFLICT: '界面插槽冲突。',
WRITER_CONFLICT: '同一资源的写者冲突。',
HOOK_CONFLICT: '独占钩子冲突。',
HOST_INCOMPATIBLE: '与当前 Host 版本不兼容。',
NETWORK_POLICY: '当前网络策略不允许该操作。',
DIAGNOSTIC_ERROR: '诊断发现阻断错误。',
PROFILE_NOT_FOUND: '配置组合不存在。',
REVISION_CONFLICT: '版本已变化，请重新读取。',
LOCKED: '操作被占用，请稍后再试。',
PATH_UNTRUSTED: '路径未通过可信校验。',
JOURNAL_CORRUPT: '恢复日志损坏，需要人工处理。',
IDEMPOTENCY_CONFLICT: '相同的操作编号对应了不同的内容。',
UNKNOWN_OPERATION: '未知操作。',
QUIESCE_BUSY: '模块仍在运行，暂不能切换。',
QUIESCE_UNKNOWN: '无法确认模块是否静止，操作保持阻断。',
WRITE_FAILED: '写入失败，已保留上一版。',
RESTART_REQUIRED: '需要重启后生效。',
ROLLED_BACK: '已恢复到上一个已验证组合。',
PARTIAL: '只有部分变更生效，需要人工处理。',
OUTCOME_UNKNOWN: '结果无法确认，请核实后再操作。',
NO_CHANGE: '没有需要变更的内容。',
INVALID_INPUT: '输入不符合要求。',
};

var DIAGNOSTIC_TEXT = {
'memory.db.locked': '本地记忆数据库被占用。',
'memory.db.corrupt': '本地记忆数据库需要恢复。',
'context.stale': '上下文观察结果已过期。',
'context.observe.failed': '上下文观察失败。',
'diagram.catalog.missing': '图示目录缺失。',
'network.policy.blocked': '网络策略已阻断该能力。',
'network.evidence.missing': '缺少网络出口证据。',
};

var INSTRUCTION_TEXT = {
'memory.recall': '在会话输入框中输入 /memory recall，然后按本地记忆技能的提示查看召回结果；本工作台不代为执行。',
'memory.open': '在会话输入框中输入 /memory open，按本地记忆技能的提示打开记忆面板。',
'context.observe': '在会话输入框中输入 /context observe，按上下文观察技能的提示查看观察视图。',
'context.maintain': '在会话输入框中输入 /context maintain，按上下文观察技能的提示执行维护步骤。',
'diagram.open': '在会话输入框中输入 /diagram open，按本地图示技能的提示打开图示。',
'rewind.open': '在会话输入框中输入 /rewind，按会话回退技能的提示选择恢复点。',
'learn.open': '在会话输入框中输入 /learn，按学习编排技能的提示继续。',
'remote.open': '按远端环境能力的说明在受控终端中使用其入口；本工作台不接触远端凭据。',
'browser.auth': '按浏览器认证能力的说明在所属插件中完成认证；本工作台不接触 cookie 或 token。',
'fixture.instruction.05': 'fixture 演示入口：本地记忆尚未接入真实 release，本卡片只展示导航指令，不执行任何操作。',
'fixture.instruction.07': 'fixture 演示入口：上下文观察尚未接入真实 release，本卡片只展示导航指令，不执行任何操作。',
};

// local pure helpers + validators
var STABLE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
var MODULE_ID = /^0[1-8]$/;
var SHA256 = /^[a-f0-9]{64}$/;
var ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
var REASON_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
var CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
var BUSINESS_STATUSES = ['ok', 'denied', 'stale', 'invalid', 'unavailable', 'failed'];
var ACTION_STATUSES = ['accepted', 'denied', 'stale', 'unavailable'];
var MODULE_STATES = ['ready', 'busy', 'attention', 'disabled', 'blocked', 'unavailable'];
var OPERATION_STATES = ['queued', 'running', 'cancelling', 'outcome_unknown'];
var ENTRY_KINDS = ['panel', 'skill', 'host_command'];
var SEVERITIES = ['error', 'warning', 'info'];

var operationCounter = 0;

function isRecord(value) {
return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value, max) {
return typeof value === 'string' && value.length > 0 && value.length <= max && !CONTROL_CHARS.test(value);
}

function isInteger(value, min) {
return typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
}

function isStringArray(value) {
if (!Array.isArray(value) || value.length > MAX_LIST) return false;
for (var index = 0; index < value.length; index += 1) {
if (!isString(value[index], 256)) return false;
}
return true;
}


function pad2(value) {
return value < 10 ? '0' + value : String(value);
}

function parseIsoTime(iso) {
if (typeof iso !== 'string' || !ISO_TIME.test(iso)) return null;
var time = Date.parse(iso);
return Number.isFinite(time) ? time : null;
}

function formatLocalTime(iso) {
var time = parseIsoTime(iso);
if (time === null) return TEXT.unknownTime;
var date = new Date(time);
return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) +
' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
}

function shortDigest(digest) {
if (typeof digest !== 'string') return '—';
return digest.length > 12 ? digest.slice(0, 12) + '…' : digest;
}

function newOperationId() {
operationCounter += 1;
var random = Math.floor(Math.random() * 0x100000000).toString(36);
return 'lw-' + Date.now().toString(36) + '-' + operationCounter.toString(36) + '-' + random;
}

function moduleLabel(moduleId) {
if (typeof moduleId === 'string' && hasOwn(MODULE_LABELS, moduleId)) return MODULE_LABELS[moduleId];
return TEXT.modulePrefix + String(moduleId);
}

function reasonText(reasonCode) {
if (typeof reasonCode === 'string' && hasOwn(REASON_TEXT, reasonCode)) return REASON_TEXT[reasonCode];
return TEXT.genericFailure;
}

function diagnosticText(diagnostic) {
var messageKey = diagnostic && diagnostic.message_key;
if (typeof messageKey === 'string' && hasOwn(DIAGNOSTIC_TEXT, messageKey)) return DIAGNOSTIC_TEXT[messageKey];
return '未登记的诊断项，请到所属模块查看。';
}

function severityText(severity) {
if (severity === 'error') return TEXT.severityError;
if (severity === 'warning') return TEXT.severityWarning;
return TEXT.severityInfo;
}

function instructionTextFor(instructionKey) {
if (typeof instructionKey === 'string' && hasOwn(INSTRUCTION_TEXT, instructionKey)) return INSTRUCTION_TEXT[instructionKey];
return TEXT.instructionFallback;
}

function validateBusinessResponse(value) {
if (!isRecord(value)) return null;
if (value.schema_version !== SCHEMA_VERSION) return null;
if (!isString(value.operation_id, 128)) return null;
if (!isInteger(value.view_epoch, 0)) return null;
if (!isInteger(value.scope_generation, 1)) return null;
if (BUSINESS_STATUSES.indexOf(value.status) < 0) return null;
if (value.status === 'ok') {
if (!hasOwn(value, 'data')) return null;
return {
operation_id: value.operation_id,
view_epoch: value.view_epoch,
scope_generation: value.scope_generation,
status: value.status,
data: value.data,
};
}
if (hasOwn(value, 'data')) return null;
if (typeof value.reason_code !== 'string' || !REASON_CODE.test(value.reason_code)) return null;
return {
operation_id: value.operation_id,
view_epoch: value.view_epoch,
scope_generation: value.scope_generation,
status: value.status,
reason_code: value.reason_code,
};
}

function sanitizeDiagnostics(value) {
if (value === undefined || value === null) return [];
if (!Array.isArray(value) || value.length > 1000) return null;
var result = [];
for (var i = 0; i < value.length; i += 1) {
var entry = value[i];
if (!isRecord(entry) || !isString(entry.code, 64) || SEVERITIES.indexOf(entry.severity) < 0) return null;
if (!isStringArray(entry.module_ids) || !isString(entry.message_key, 128)) return null;
if (entry.resource_ref !== null && entry.resource_ref !== undefined && !isString(entry.resource_ref, 256)) return null;
result.push({code: entry.code, severity: entry.severity, module_ids: entry.module_ids.slice(), resource_ref: entry.resource_ref === undefined ? null : entry.resource_ref, message_key: entry.message_key});
}
return result;
}

function sanitizeContext(entry) {
if (!isRecord(entry) || !isString(entry.context_ref, 64) || !STABLE_ID.test(entry.context_ref)) return null;
if (!isString(entry.scope_ref, 256) || !isInteger(entry.scope_generation, 1)) return null;
if (entry.session_ref !== null && !isString(entry.session_ref, 256)) return null;
if (!isString(entry.context_revision, 256) || !isString(entry.profile_ref, 256)) return null;
if (!isInteger(entry.profile_revision, 0) || !isStringArray(entry.selected_module_ids) || !isStringArray(entry.allowed_module_ids)) return null;
if (!isString(entry.label, 256) || typeof entry.active !== 'boolean') return null;
return {context_ref: entry.context_ref, scope_ref: entry.scope_ref, scope_generation: entry.scope_generation, session_ref: entry.session_ref, context_revision: entry.context_revision, profile_ref: entry.profile_ref, profile_revision: entry.profile_revision, selected_module_ids: entry.selected_module_ids.slice(), allowed_module_ids: entry.allowed_module_ids.slice(), label: entry.label, active: entry.active};
}

function validateContextListData(data) {
if (!isRecord(data)) return null;
if (!Array.isArray(data.contexts) || data.contexts.length > MAX_LIST) return null;
var contexts = [];
for (var index = 0; index < data.contexts.length; index += 1) {
var context = sanitizeContext(data.contexts[index]);
if (context === null) return null;
contexts.push(context);
}
var diagnostics = sanitizeDiagnostics(data.diagnostics);
if (diagnostics === null) return null;
return {contexts: contexts, diagnostics: diagnostics, fixture_mode: data.fixture_mode === true, modules: sanitizeCatalogModules(data.modules)};
}

/* Read-only catalog summary added to context.list data: {module_id, name,
release_version, entry_kind, fixture}. Rows are display metadata only; malformed
rows are ignored (never fail the whole discovery) and the array is bounded. */
function sanitizeCatalogModules(value) {
if (!Array.isArray(value)) return [];
var rows = [];
var seen = {};
var limit = Math.min(value.length, 32);
for (var index = 0; index < limit; index += 1) {
var row = value[index];
if (!isRecord(row)) continue;
if (!isString(row.module_id, 8) || !MODULE_ID.test(row.module_id)) continue;
if (!isString(row.name, 128) || !isString(row.release_version, 64)) continue;
if (ENTRY_KINDS.indexOf(row.entry_kind) < 0) continue;
if (typeof row.fixture !== 'boolean') continue;
if (seen[row.module_id] === true) continue;
seen[row.module_id] = true;
rows.push({module_id: row.module_id, name: row.name, release_version: row.release_version, entry_kind: row.entry_kind, fixture: row.fixture});
}
return rows;
}

function catalogRow(catalog, moduleId) {
if (!Array.isArray(catalog)) return null;
for (var index = 0; index < catalog.length; index += 1) {
if (catalog[index].module_id === moduleId) return catalog[index];
}
return null;
}

function moduleDisplayName(catalog, moduleId) {
var row = catalogRow(catalog, moduleId);
if (row !== null) return row.name;
return moduleLabel(moduleId);
}

function sanitizeModule(module) {
if (!isRecord(module) || module.schema_version !== SCHEMA_VERSION) return null;
if (!isString(module.module_id, 8) || !MODULE_ID.test(module.module_id) || !isString(module.scope_ref, 256)) return null;
if (module.session_ref !== null && !isString(module.session_ref, 256)) return null;
if (!isInteger(module.generation, 0) || !isInteger(module.revision, 0) || MODULE_STATES.indexOf(module.state) < 0) return null;
if (module.reason_code !== null && (typeof module.reason_code !== 'string' || !REASON_CODE.test(module.reason_code))) return null;
if (!Array.isArray(module.active_operations) || module.active_operations.length > 32) return null;
if (!isString(module.updated_at, 64) || !ISO_TIME.test(module.updated_at) || !isStringArray(module.capabilities)) return null;
var operations = [];
for (var i = 0; i < module.active_operations.length; i += 1) {
var operation = module.active_operations[i];
if (!isRecord(operation) || !isString(operation.operation_id, 256) || !isString(operation.kind, 256) || OPERATION_STATES.indexOf(operation.state) < 0) return null;
operations.push({operation_id: operation.operation_id, kind: operation.kind, state: operation.state});
}
return {schema_version: SCHEMA_VERSION, module_id: module.module_id, scope_ref: module.scope_ref, session_ref: module.session_ref, generation: module.generation, revision: module.revision, state: module.state, reason_code: module.reason_code, active_operations: operations, updated_at: module.updated_at, capabilities: module.capabilities.slice()};
}

function validateStatusData(data) {
if (!isRecord(data) || typeof data.changed !== 'boolean' || !isInteger(data.revision, 0)) return null;
if (!isString(data.scope_ref, 256) || !isInteger(data.scope_generation, 1) || !isString(data.context_revision, 256)) return null;
if (!Array.isArray(data.modules) || data.modules.length > MAX_LIST) return null;
var modules = [];
for (var i = 0; i < data.modules.length; i += 1) {
var module = sanitizeModule(data.modules[i]);
if (module === null) return null;
modules.push(module);
}
var diagnostics = sanitizeDiagnostics(data.diagnostics);
if (diagnostics === null) return null;
return {changed: data.changed, revision: data.revision, scope_ref: data.scope_ref, scope_generation: data.scope_generation, context_revision: data.context_revision, modules: modules, diagnostics: diagnostics};
}

function sanitizeNavigationTarget(target) {
if (!isRecord(target)) return null;
if (target.kind === 'panel') {
if (!isString(target.panel_key, 64) || !STABLE_ID.test(target.panel_key)) return null;
return {kind: 'panel', panel_key: target.panel_key};
}
if (target.kind === 'skill') {
if (!isString(target.skill_ref, 256)) return null;
if (!isString(target.instruction_key, 64) || !STABLE_ID.test(target.instruction_key)) return null;
return {kind: 'skill', skill_ref: target.skill_ref, instruction_key: target.instruction_key};
}
if (target.kind === 'host_command') {
if (!isString(target.command_ref, 256)) return null;
if (!isString(target.instruction_key, 64) || !STABLE_ID.test(target.instruction_key)) return null;
return {kind: 'host_command', command_ref: target.command_ref, instruction_key: target.instruction_key};
}
return null;
}

function validateActionResult(value) {
if (!isRecord(value)) return null;
if (value.schema_version !== SCHEMA_VERSION) return null;
if (!isString(value.operation_id, 128)) return null;
if (ACTION_STATUSES.indexOf(value.status) < 0) return null;
if (!isString(value.owner_module, 8) || !MODULE_ID.test(value.owner_module)) return null;
if (value.reason_code !== null && (typeof value.reason_code !== 'string' || !REASON_CODE.test(value.reason_code))) return null;
if (value.status === 'accepted' && !isRecord(value.navigation_intent)) return null;
return {
operation_id: value.operation_id,
status: value.status,
owner_module: value.owner_module,
reason_code: value.reason_code === undefined ? null : value.reason_code,
navigation_intent: value.navigation_intent === undefined ? null : value.navigation_intent,
};
}

function validateNavigationIntent(value) {
if (!isRecord(value)) return null;
if (value.schema_version !== SCHEMA_VERSION) return null;
if (!isString(value.intent_id, 128)) return null;
if (!isString(value.operation_id, 128)) return null;
if (!isString(value.owner_module, 8) || !MODULE_ID.test(value.owner_module)) return null;
if (!isString(value.scope_ref, 256)) return null;
if (!isInteger(value.scope_generation, 1)) return null;
if (!isString(value.context_revision, 256)) return null;
if (!isInteger(value.module_revision, 0)) return null;
if (!isString(value.composition_digest, 64) || !SHA256.test(value.composition_digest)) return null;
if (typeof value.expires_at !== 'string' || !ISO_TIME.test(value.expires_at)) return null;
var target = sanitizeNavigationTarget(value.target);
if (target === null) return null;
return {
schema_version: SCHEMA_VERSION,
intent_id: value.intent_id,
operation_id: value.operation_id,
owner_module: value.owner_module,
scope_ref: value.scope_ref,
scope_generation: value.scope_generation,
context_revision: value.context_revision,
module_revision: value.module_revision,
composition_digest: value.composition_digest,
expires_at: value.expires_at,
target: target,
};
}

function validatePreviewData(data) {
if (!isRecord(data) || !isString(data.preview_id, 128) || !isRecord(data.diff)) return null;
var diff = data.diff;
if (!isStringArray(diff.added) || !isStringArray(diff.removed) || !isStringArray(diff.unchanged)) return null;
if (!Array.isArray(diff.changed) || diff.changed.length > MAX_LIST) return null;
if (!isString(data.composition_digest, 64) || !SHA256.test(data.composition_digest)) return null;
if (typeof data.expires_at !== 'string' || !ISO_TIME.test(data.expires_at)) return null;
var changed = [];
for (var i = 0; i < diff.changed.length; i += 1) {
var entry = diff.changed[i];
if (!isRecord(entry) || !isString(entry.id, 64) || !isString(entry.before, 128) || !isString(entry.after, 128)) return null;
changed.push({id: entry.id, before: entry.before, after: entry.after});
}
return {preview_id: data.preview_id, diff: {added: diff.added.slice(), removed: diff.removed.slice(), changed: changed, unchanged: diff.unchanged.slice()}, composition_digest: data.composition_digest, expires_at: data.expires_at};
}

// scoped stylesheet
var CSS = [
'.lw-root{font-size:14px;line-height:1.5;color:inherit;background:transparent;padding:16px;max-width:1100px;margin:0 auto;overflow-wrap:anywhere;font-family:system-ui,"Segoe UI","Microsoft YaHei",sans-serif;}',
'.lw-header{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start;justify-content:space-between;padding-bottom:12px;border-bottom:1px solid rgba(127,127,127,0.35);margin-bottom:16px;}',
'.lw-header-main{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start;justify-content:space-between;flex:1 1 320px;}',
'.lw-brand{display:flex;gap:10px;align-items:flex-start;}',
'.lw-title{font-size:18px;line-height:1.4;margin:0 0 2px;font-weight:600;}',
'.lw-meta{margin:2px 0;color:rgba(127,127,127,0.95);}',
'.lw-header-actions,.lw-card-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px;}',
'.lw-btn{font:inherit;line-height:1.5;padding:6px 12px;border-radius:8px;border:1px solid rgba(127,127,127,0.45);background:transparent;color:inherit;cursor:pointer;min-height:32px;}',
'.lw-btn:disabled{cursor:not-allowed;opacity:0.6;}',
'.lw-btn-primary{border-color:rgba(64,128,255,0.65);}',
'.lw-btn-quiet{border-style:dashed;}',
'.lw-btn-active{border-color:rgba(64,128,255,0.9);background:rgba(64,128,255,0.12);}',
'.lw-btn:focus-visible,.lw-check input:focus-visible,.lw-error-summary:focus-visible{outline:2px solid rgba(64,128,255,0.9);outline-offset:2px;}',
'.lw-live{min-height:20px;margin:4px 0 8px;color:rgba(127,127,127,0.95);}',
'.lw-grid{display:grid;grid-template-columns:1fr;gap:12px;}',
'.lw-card{border:1px solid rgba(127,127,127,0.35);border-radius:10px;padding:12px;background:transparent;display:flex;flex-direction:column;gap:4px;}',
'.lw-card-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap;}',
'.lw-card-title{font-size:16px;margin:0;line-height:1.4;}',
'.lw-state{padding:1px 8px;border-radius:999px;border:1px solid currentColor;}',
'.lw-state-ready{color:#1a7f37;}',
'.lw-state-busy{color:#9a6700;}',
'.lw-state-attention{color:#b35900;}',
'.lw-state-disabled,.lw-state-unavailable{color:#6e7781;}',
'.lw-state-blocked{color:#cf222e;}',
'.lw-error{color:#cf222e;margin:4px 0;}',
'.lw-error-summary{border:1px solid rgba(207,34,46,0.6);border-radius:10px;padding:10px 12px;margin:8px 0;}',
'.lw-section{margin:20px 0;}',
'.lw-section-title{font-size:16px;margin:0 0 8px;line-height:1.4;}',
'.lw-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap;}',
'.lw-issues,.lw-ops{margin:0;padding-left:20px;}',
'.lw-later summary{cursor:pointer;font-size:16px;font-weight:600;}',
'.lw-checks{list-style:none;margin:8px 0;padding:0;display:grid;grid-template-columns:1fr;gap:6px;}',
'.lw-check{display:inline-flex;align-items:center;gap:8px;}',
'.lw-diff{border:1px dashed rgba(127,127,127,0.5);border-radius:10px;padding:10px;margin:8px 0;}',
'.lw-instruction{border:1px solid rgba(64,128,255,0.5);border-radius:10px;padding:12px;margin:16px 0;}',
'.lw-instruction-text{white-space:pre-wrap;margin:8px 0;}',
'.lw-fixture{border:1px dashed rgba(154,103,0,0.7);border-radius:8px;padding:6px 10px;margin:8px 0;}',
'.lw-contexts{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0;}',
'.lw-blocked{border:1px dashed rgba(127,127,127,0.5);border-radius:10px;padding:16px;}',
'.lw-muted,.lw-note{color:rgba(127,127,127,0.95);}',
'@media (min-width:640px){',
'  .lw-grid,.lw-checks{grid-template-columns:repeat(2,minmax(0,1fr));}',
'}',
'@media (prefers-reduced-motion:reduce){',
'  .lw-root *,.lw-root *::before,.lw-root *::after{transition:none !important;animation:none !important;}',
'}',
'@media (prefers-color-scheme:dark){',
'  .lw-state-ready{color:#3fb950;}',
'  .lw-state-busy{color:#d29922;}',
'  .lw-state-attention{color:#db6d28;}',
'  .lw-state-blocked,.lw-error,.lw-error-summary{color:#f85149;}',
'}',
].join('\n');

// one-time style injection
var styleElement = null;

function findStyle() {
try {
return document.querySelector('style[data-local-workbench]');
} catch (error) {
return null;
}
}

function ensureStyle() {
if (typeof document === 'undefined' || document === null || !document.head) return null;
if (styleElement !== null && styleElement.parentNode) return styleElement;
var existing = findStyle();
if (existing !== null) {
styleElement = existing;
return existing;
}
var node = document.createElement('style');
node.setAttribute('data-local-workbench', '');
node.textContent = CSS;
document.head.appendChild(node);
styleElement = node;
return node;
}

function removeStyle(node) {
if (node && node.parentNode) node.parentNode.removeChild(node);
if (styleElement === node) styleElement = null;
}

// inline svg icons (no emoji-only glyphs)
function SvgIcon(props) {
return el('svg', {
'aria-hidden': 'true',
focusable: 'false',
width: props.size || 16,
height: props.size || 16,
viewBox: '0 0 16 16',
role: 'presentation',
}, props.paths.map(function (path, index) {
return el('path', {
key: index,
d: path,
fill: 'none',
stroke: 'currentColor',
strokeWidth: 1.5,
strokeLinecap: 'round',
strokeLinejoin: 'round',
});
}));
}

function WorkbenchIcon(props) {
var size = props && props.size ? props.size : 18;
return el('svg', {
'aria-hidden': 'true',
focusable: 'false',
width: size,
height: size,
viewBox: '0 0 18 18',
},
el('rect', {x: 2, y: 2, width: 6, height: 6, rx: 1, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5}),
el('rect', {x: 10, y: 2, width: 6, height: 6, rx: 1, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5}),
el('rect', {x: 2, y: 10, width: 6, height: 6, rx: 1, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5}),
el('rect', {x: 10, y: 10, width: 6, height: 6, rx: 1, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5})
);
}

function BackIcon() {
return el(SvgIcon, {paths: ['M9.5 3.5 5 8l4.5 4.5', 'M5 8h8']});
}

function RefreshIcon() {
return el(SvgIcon, {paths: ['M13 8a5 5 0 1 1-1.5-3.5', 'M13 2.5V5h-2.5']});
}

function AlertIcon() {
return el(SvgIcon, {paths: ['M8 2v7', 'M8 12.5v.5']});
}

// pure presentational components
function LiveRegion(props) {
return el('div', {className: 'lw-live', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true'}, props.message);
}

function ErrorSummary(props) {
if (!props.text) return null;
return el('div', {
className: 'lw-error lw-error-summary',
role: 'alert',
tabIndex: -1,
ref: props.focusRef,
}, el('strong', null, '操作遇到问题：'), ' ' + props.text);
}

function Header(props) {
var context = props.context;
var texts = props.texts;
return el('header', {className: 'lw-header'},
el('div', {className: 'lw-header-main'},
el('div', {className: 'lw-brand'},
el(WorkbenchIcon, {size: 22}),
el('div', null,
el('h1', {className: 'lw-title'}, PANEL_LABEL),
el('p', {className: 'lw-meta'}, context ? texts.currentContext + context.label : texts.notSelected),
el('p', {className: 'lw-meta'}, context
? texts.session + (context.session_ref || texts.notBound) + ' · ' + texts.compositionRevision + context.profile_revision
: texts.session + texts.notBound)
)
),
el('div', {className: 'lw-header-actions'},
context ? el('button', {
type: 'button',
className: 'lw-btn',
onClick: props.onReturnToChat,
}, el(BackIcon), ' ', texts.returnChat) : null
)
),
props.contexts.length > 1 ? el('nav', {className: 'lw-contexts', 'aria-label': texts.contextNavLabel},
el('span', {className: 'lw-meta'}, texts.switchContext),
props.contexts.map(function (entry) {
var active = context !== null && context.context_ref === entry.context_ref;
return el('button', {
key: entry.context_ref,
type: 'button',
className: 'lw-btn lw-btn-quiet' + (active ? ' lw-btn-active' : ''),
'aria-pressed': active ? 'true' : 'false',
onClick: function () { props.onSelectContext(entry.context_ref); },
}, entry.label);
})
) : null,
props.fixtureMode ? el('p', {className: 'lw-fixture', role: 'note'}, TEXT.fixtureBanner) : null
);
}

function ModuleCard(props) {
var module = props.module;
var label = props.displayName;
var row = props.catalogRow;
var stateText = STATE_TEXT[module.state] || module.state;
var entryAllowed = module.state === 'ready' || module.state === 'attention';
var disabledText = entryAllowed ? null : (ENTRY_DISABLED_TEXT[module.state] || '该状态暂不可进入。');
var versionLine = row !== null
? row.module_id + ' · ' + row.name + (row.fixture ? ' (fixture)' : '') + ' · ' + row.release_version
: TEXT.modulePrefix + module.module_id + ' · ' + TEXT.generationPrefix + module.generation + ' · ' + TEXT.revisionPrefix + module.revision;
return el('article', {className: 'lw-card', 'data-module-id': module.module_id},
el('div', {className: 'lw-card-head'},
el('h3', {className: 'lw-card-title'}, label),
el('span', {className: 'lw-state lw-state-' + module.state}, stateText)
),
el('p', {className: 'lw-meta lw-version'}, versionLine),
module.reason_code !== null ? el('p', {className: 'lw-meta'}, TEXT.reasonPrefix + reasonText(module.reason_code)) : null,
el('p', {className: 'lw-meta'}, TEXT.updatedAt + formatLocalTime(module.updated_at)),
module.active_operations.length > 0 ? el('ul', {className: 'lw-ops'}, module.active_operations.map(function (operation) {
return el('li', {key: operation.operation_id},
TEXT.operationPrefix + operation.operation_id + '：' + (OPERATION_STATE_TEXT[operation.state] || operation.state));
})) : null,
props.error ? el('p', {className: 'lw-error', role: 'alert'}, props.error) : null,
el('div', {className: 'lw-card-actions'},
el('button', {
type: 'button',
className: 'lw-btn lw-btn-primary',
disabled: props.busy || !entryAllowed,
onClick: function () { props.onOpen(module.module_id); },
}, props.busy ? TEXT.busyPreparing : TEXT.enter + label),
disabledText ? el('span', {className: 'lw-meta'}, disabledText) : null
)
);
}

function DiffView(props) {
var preview = props.preview;
var diff = preview.diff;
function moduleIds(ids) {
if (!ids.length) return TEXT.diffNone;
return ids.map(function (id) { return moduleLabel(id) + '（' + id + '）'; }).join('、');
}
var changedText = diff.changed.length === 0 ? TEXT.diffNone : diff.changed.map(function (entry) {
return moduleLabel(entry.id) + '（' + entry.before + ' → ' + entry.after + '）';
}).join('、');
return el('div', {className: 'lw-diff'},
el('p', {className: 'lw-meta'}, TEXT.previewPrefix + preview.preview_id + ' · ' + TEXT.digestPrefix + shortDigest(preview.composition_digest)),
el('ul', null,
el('li', null, TEXT.diffAdded + moduleIds(diff.added)),
el('li', null, TEXT.diffRemoved + moduleIds(diff.removed)),
el('li', null, TEXT.diffChanged + changedText),
el('li', null, TEXT.diffUnchanged + moduleIds(diff.unchanged))
)
);
}

function CompositionSection(props) {
var composition = props.composition;
var context = props.context;
var diagnostics = props.diagnostics;
var candidates = props.candidates;
var selectedIds = composition.selectedIds || [];
return el('section', {className: 'lw-section', 'aria-labelledby': 'lw-composition-title'},
el('div', {className: 'lw-section-head'},
el('h2', {id: 'lw-composition-title', className: 'lw-section-title'}, TEXT.compositionTitle),
el('button', {
type: 'button',
className: 'lw-btn',
'aria-expanded': props.open ? 'true' : 'false',
onClick: props.onToggleOpen,
}, props.open ? TEXT.compositionCollapse : TEXT.compositionCheck)
),
el('p', {className: 'lw-meta'}, TEXT.compositionRevision + context.profile_revision),
composition.preview !== null ? el('p', {className: 'lw-meta'}, TEXT.previewDigest + shortDigest(composition.preview.composition_digest)) : null,
props.open ? el(Fragment, null,
el('p', {className: 'lw-meta'}, TEXT.compositionHint),
el('ul', {className: 'lw-checks'}, candidates.map(function (moduleId) {
var checked = selectedIds.indexOf(moduleId) >= 0;
return el('li', {key: moduleId},
el('label', {className: 'lw-check'},
el('input', {
type: 'checkbox',
checked: checked,
'aria-label': moduleLabel(moduleId) + '（' + moduleId + '）',
onChange: function (event) { props.onToggleModule(moduleId, event.target.checked === true); },
}),
' ' + moduleLabel(moduleId) + '（' + moduleId + '）'
)
);
})),
composition.busy ? el('p', {className: 'lw-meta', role: 'status'}, TEXT.compositionBusy) : null,
composition.error ? el('p', {className: 'lw-error', role: 'alert'}, composition.error) : null,
composition.preview !== null ? el(DiffView, {preview: composition.preview}) : null,
el('p', {className: 'lw-note'}, TEXT.compositionApplyNote)
) : null,
diagnostics.length > 0 ? el('ul', {className: 'lw-issues'}, diagnostics.map(function (diagnostic, index) {
return el('li', {key: diagnostic.code + '-' + index},
severityText(diagnostic.severity) + '：' + diagnosticText(diagnostic));
})) : null
);
}

function InstructionCard(props) {
var instruction = props.instruction;
return el('section', {className: 'lw-instruction', 'aria-labelledby': 'lw-instruction-title'},
el('h2', {id: 'lw-instruction-title', className: 'lw-section-title'}, TEXT.instructionTitle),
el('p', {className: 'lw-meta'}, TEXT.instructionModule + moduleLabel(instruction.moduleId) + ' · ' + (instruction.kind === 'skill' ? TEXT.instructionKindSkill : TEXT.instructionKindCommand)),
el('p', {className: 'lw-meta'}, TEXT.instructionRef + instruction.refText + ' · ' + TEXT.instructionKey + instruction.instructionKey),
el('p', {className: 'lw-instruction-text'}, instruction.text),
el('p', {className: 'lw-note'}, TEXT.instructionSafety),
el('div', {className: 'lw-card-actions'},
el('button', {type: 'button', className: 'lw-btn lw-btn-primary', onClick: props.onCopy}, TEXT.copy),
el('button', {type: 'button', className: 'lw-btn', onClick: props.onClose}, TEXT.closeInstruction),
props.copyState === 'copied' ? el('span', {className: 'lw-meta', role: 'status'}, TEXT.copyOk) : null,
props.copyState === 'failed' ? el('span', {className: 'lw-meta', role: 'status'}, TEXT.copyFailed) : null
)
);
}

function emptyComposition() {
return {busy: false, selectedIds: null, preview: null, error: null};
}

// local view store helpers
function createInitialView() {
return {
phase: 'discovering',
contexts: [],
catalog: [],
context: null,
fixtureMode: false,
status: null,
epoch: 0,
lastUpdatedAt: null,
discoveryError: null,
statusError: null,
notice: null,
actionError: null,
navBusyModule: null,
instruction: null,
copyState: 'idle',
showComposition: false,
composition: emptyComposition(),
refreshNonce: 0,
compositionDigest: null,
};
}

function issuesFor(view) {
var issues = [];
if (!view.status) return issues;
view.status.modules.forEach(function (module) {
var label = moduleLabel(module.module_id);
if (module.state === 'attention') {
issues.push({key: 'state-attention-' + module.module_id, text: label + '：' + TEXT.attentionState + (module.reason_code !== null ? '（' + reasonText(module.reason_code) + '）' : '')});
}
if (module.state === 'blocked') {
issues.push({key: 'state-blocked-' + module.module_id, text: label + '：' + TEXT.blockedState + (module.reason_code !== null ? '（' + reasonText(module.reason_code) + '）' : '')});
}
module.active_operations.forEach(function (operation) {
if (operation.state === 'outcome_unknown') {
issues.push({key: 'operation-' + module.module_id + '-' + operation.operation_id, text: label + '：' + TEXT.operationPrefix + operation.operation_id + ' ' + TEXT.operationUnknownText});
}
});
});
view.status.diagnostics.forEach(function (diagnostic, index) {
if (diagnostic.severity !== 'error' && diagnostic.severity !== 'warning') return;
var modules = diagnostic.module_ids.length > 0 ? '（' + diagnostic.module_ids.map(moduleLabel).join('、') + '）' : '';
issues.push({key: 'diagnostic-' + diagnostic.code + '-' + index, text: severityText(diagnostic.severity) + '：' + diagnosticText(diagnostic) + modules});
});
return issues;
}

function compositionCandidates(view) {
var context = view.context;
if (!context) return [];
var seen = {};
var candidates = [];
var sources = [context.allowed_module_ids, context.selected_module_ids, view.composition.selectedIds || []];
sources.forEach(function (list) {
list.forEach(function (moduleId) {
if (seen[moduleId]) return;
seen[moduleId] = true;
if (MODULE_ID.test(moduleId)) candidates.push(moduleId);
});
});
candidates.sort();
return candidates;
}

// the only hook-bearing component
function WorkbenchPanel(props) {
var ctx = props.ctx;
var [view, setView] = useState(createInitialView);
var viewRef = useRef(view);
viewRef.current = view;

var epochRef = useRef(0);
var discoveryAbortRef = useRef(null);
var discoverySeqRef = useRef(0);
var statusInFlightRef = useRef(null);
var intentsRef = useRef(new Map());
var compositionSeqRef = useRef(0);
var copyTimerRef = useRef(null);
var errorSummaryRef = useRef(null);

function patchView(patch) {
setView(function (previous) {
return assign({}, previous, patch(previous));
});
}

function makeShell(contextRef, generation, epoch, input) {
return {
schema_version: SCHEMA_VERSION,
operation_id: newOperationId(),
context_ref: contextRef,
expected_scope_generation: isInteger(generation, 1) ? generation : 1,
view_epoch: isInteger(epoch, 0) ? epoch : 0,
input: input,
};
}

function callRpc(endpoint, request, signal) {
return ctx.connection.rpc.call(CHANNEL, endpoint, request, signal).then(function (result) {
if (signal && signal.aborted) return {kind: 'aborted'};
if (!result || result.ok !== true) return {kind: 'transport_failure'};
var response = validateBusinessResponse(result.value);
if (response === null) return {kind: 'protocol_failure'};
if (response.operation_id !== request.operation_id) return {kind: 'protocol_failure'};
if (response.status !== 'ok') return {kind: 'business_failure', reason_code: response.reason_code, response: response};
return {kind: 'ok', response: response};
}, function (error) {
if (signal && signal.aborted) return {kind: 'aborted'};
if (error && error.name === 'AbortError') return {kind: 'aborted'};
return {kind: 'transport_failure'};
});
}

function abortStatusInFlight() {
if (statusInFlightRef.current !== null) {
var controller = statusInFlightRef.current;
statusInFlightRef.current = null;
try {
controller.abort();
} catch (error) {
}
}
}

function setDiscoveryFailure(text) {
patchView(function (previous) {
return {
discoveryError: text,
phase: previous.context === null ? 'failed' : previous.phase === 'discovering' || previous.phase === 'refreshing' ? 'ready' : previous.phase,
};
});
}

function setStatusError(text) {
if (viewRef.current.statusError === text) return;
patchView(function () {
return {statusError: text};
});
}

function setActionError(moduleId, text) {
patchView(function () {
return {actionError: {moduleId: moduleId, text: text}, notice: null};
});
}

function recordReceipt(intent, clientState, reasonCode) {
var current = viewRef.current;
if (!current.context) return;
var input = {intent_id: intent.intent_id, client_state: clientState};
if (typeof reasonCode === 'string') input.reason_code = reasonCode;
var request = makeShell(current.context.context_ref, current.context.scope_generation, epochRef.current, input);
callRpc('navigation.receipt', request, undefined).then(null, function () {
});
}

function rememberIntent(intentId) {
var map = intentsRef.current;
map.delete(intentId);
map.set(intentId, true);
while (map.size > MAX_DEDUPE_INTENTS) {
var oldest = map.keys().next();
if (oldest.done) break;
map.delete(oldest.value);
}
}

function discoverContexts(reason) {
discoverySeqRef.current += 1;
var seq = discoverySeqRef.current;
if (discoveryAbortRef.current !== null) {
try {
discoveryAbortRef.current.abort();
} catch (error) {
}
}
var controller = typeof AbortController === 'function' ? new AbortController() : null;
discoveryAbortRef.current = controller;
var requestEpoch = epochRef.current;
var current = viewRef.current;
var contextRef = current.context !== null ? current.context.context_ref : BOOTSTRAP_CONTEXT_REF;
var generation = current.context !== null ? current.context.scope_generation : 1;
var request = makeShell(contextRef, generation, requestEpoch, {});
callRpc('context.list', request, controller !== null ? controller.signal : undefined).then(function (result) {
if (seq !== discoverySeqRef.current) return;
if (controller !== null && controller.signal.aborted) return;
if (requestEpoch !== epochRef.current) return;
if (result.kind === 'aborted') return;
if (result.kind === 'transport_failure') {
setDiscoveryFailure(TEXT.transportFailure);
return;
}
if (result.kind === 'protocol_failure') {
setDiscoveryFailure(TEXT.protocolFailure);
return;
}
if (result.kind === 'business_failure') {
setDiscoveryFailure(reasonText(result.reason_code));
return;
}
var data = validateContextListData(result.response.data);
if (data === null) {
setDiscoveryFailure(TEXT.protocolFailure);
return;
}
applyContextList(data, reason);
});
}

function applyContextList(data, reason) {
var current = viewRef.current;
var contexts = data.contexts;
var previous = current.context;
var chosen = null;
var index;
if (previous !== null) {
for (index = 0; index < contexts.length; index += 1) {
if (contexts[index].context_ref === previous.context_ref) {
chosen = contexts[index];
break;
}
}
}
if (chosen === null && contexts.length === 1) chosen = contexts[0];
var scopeChanged = chosen !== null && (
previous === null ||
previous.context_ref !== chosen.context_ref ||
previous.scope_generation !== chosen.scope_generation ||
previous.context_revision !== chosen.context_revision
);
patchView(function (latest) {
var merged = {
contexts: contexts,
catalog: data.modules,
fixtureMode: data.fixture_mode === true,
discoveryError: null,
};
if (contexts.length === 0) {
merged.phase = 'blocked';
merged.context = null;
merged.status = null;
merged.instruction = null;
merged.composition = emptyComposition();
} else if (chosen !== null) {
merged.phase = 'ready';
merged.context = chosen;
if (scopeChanged) {
merged.status = null;
merged.statusError = null;
merged.actionError = null;
merged.instruction = null;
merged.copyState = 'idle';
merged.composition = emptyComposition();
merged.epoch = epochRef.current;
}
} else {
merged.phase = 'choosing';
merged.context = null;
merged.status = null;
merged.instruction = null;
merged.composition = emptyComposition();
}
if (reason === 'scope-change' && !scopeChanged && latest.context !== null && latest.context.context_ref === (chosen === null ? latest.context.context_ref : chosen.context_ref)) {
merged.phase = 'ready';
merged.context = chosen;
}
return merged;
});
}

function onScopeChanged() {
abortStatusInFlight();
epochRef.current += 1;
intentsRef.current.clear();
patchView(function () {
return {
phase: 'refreshing',
status: null,
statusError: null,
actionError: null,
instruction: null,
epoch: epochRef.current,
};
});
discoverContexts('scope-change');
}

function applyStatusResult(request, context, result) {
if (result.kind === 'aborted') return;
var latest = viewRef.current;
if (!latest.context || latest.context.context_ref !== context.context_ref) return;
if (result.kind === 'transport_failure') {
setStatusError(TEXT.transportFailure);
return;
}
if (result.kind === 'protocol_failure') {
setStatusError(TEXT.protocolFailure);
return;
}
if (result.kind === 'business_failure') {
setStatusError(reasonText(result.reason_code));
return;
}
var response = result.response;
if (response.view_epoch !== request.view_epoch) return;
if (response.scope_generation !== context.scope_generation) {
onScopeChanged();
return;
}
var data = validateStatusData(response.data);
if (data === null) {
setStatusError(TEXT.protocolFailure);
return;
}
if (data.scope_generation !== context.scope_generation || data.context_revision !== context.context_revision) {
onScopeChanged();
return;
}
if (data.scope_ref !== context.scope_ref) {
setStatusError(TEXT.protocolFailure);
return;
}
if (data.changed !== true) return;
patchView(function (previous) {
if (!previous.context || previous.context.context_ref !== context.context_ref) return {};
if (previous.context.scope_generation !== context.scope_generation) return {};
return {status: data, statusError: null, lastUpdatedAt: Date.now()};
});
}

function chooseContext(contextRef) {
var latest = viewRef.current;
var entry = null;
for (var index = 0; index < latest.contexts.length; index += 1) {
if (latest.contexts[index].context_ref === contextRef) {
entry = latest.contexts[index];
break;
}
}
if (entry === null) return;
if (latest.context !== null && latest.context.context_ref === entry.context_ref) return;
abortStatusInFlight();
if (discoveryAbortRef.current !== null) {
try {
discoveryAbortRef.current.abort();
} catch (error) {
}
discoveryAbortRef.current = null;
}
discoverySeqRef.current += 1;
epochRef.current += 1;
intentsRef.current.clear();
patchView(function () {
return {
context: entry,
phase: 'ready',
status: null,
statusError: null,
actionError: null,
instruction: null,
copyState: 'idle',
notice: null,
epoch: epochRef.current,
composition: emptyComposition(),
showComposition: false,
};
});
}

function retryDiscovery() {
abortStatusInFlight();
patchView(function (previous) {
return {phase: previous.context === null ? 'discovering' : 'refreshing', discoveryError: null, statusError: null};
});
discoverContexts('retry');
}

function refreshStatus() {
patchView(function (previous) {
return {statusError: null, refreshNonce: previous.refreshNonce + 1};
});
}

function returnToChat() {
try {
ctx.layout.selectPanel(null);
patchView(function () {
return {notice: TEXT.returned, instruction: null, copyState: 'idle'};
});
} catch (error) {
setActionError(null, TEXT.transportFailure);
}
}

function clearNavigationBusy() {
patchView(function (previous) {
return previous.navBusyModule === null ? {} : {navBusyModule: null};
});
}

function openModule(moduleId) {
var latest = viewRef.current;
if (latest.navBusyModule !== null) return;
if (latest.phase !== 'ready' || latest.context === null) return;
var context = latest.context;
var signal;
try {
signal = ctx.layout.beginNavigation();
} catch (error) {
signal = null;
}
var requestEpoch = epochRef.current;
patchView(function () {
return {navBusyModule: moduleId, actionError: null, notice: null};
});
var request = makeShell(context.context_ref, context.scope_generation, requestEpoch, {module_id: moduleId});
callRpc('navigation.prepare', request, signal).then(function (result) {
if (requestEpoch !== epochRef.current) return;
if (signal !== null && signal.aborted) return;
var current = viewRef.current;
if (!current.context || current.context.context_ref !== context.context_ref) return;
clearNavigationBusy();
handlePrepareResult(context, moduleId, result);
}, function () {
clearNavigationBusy();
setActionError(moduleId, TEXT.transportFailure);
});
}

function handlePrepareResult(context, moduleId, result) {
if (result.kind === 'aborted') return;
if (result.kind === 'transport_failure') {
setActionError(moduleId, TEXT.transportFailure);
return;
}
if (result.kind === 'protocol_failure') {
setActionError(moduleId, TEXT.protocolFailure);
return;
}
if (result.kind === 'business_failure') {
setActionError(moduleId, reasonText(result.reason_code));
return;
}
var action = validateActionResult(result.response.data);
if (action === null) {
setActionError(moduleId, TEXT.protocolFailure);
return;
}
if (action.status !== 'accepted') {
setActionError(moduleId, reasonText(action.reason_code));
return;
}
var intent = validateNavigationIntent(action.navigation_intent);
if (intent === null) {
setActionError(moduleId, TEXT.protocolFailure);
return;
}
executeIntent(context, moduleId, intent);
}

function executeIntent(context, moduleId, intent) {
if (intent.owner_module !== moduleId) {
setActionError(moduleId, TEXT.intentInvalid);
return;
}
if (intent.scope_ref !== context.scope_ref || intent.scope_generation !== context.scope_generation) {
recordReceipt(intent, 'stale', 'STALE_SCOPE');
setActionError(moduleId, TEXT.staleScope);
return;
}
if (intent.context_revision !== context.context_revision) {
recordReceipt(intent, 'stale', 'STALE_REVISION');
setActionError(moduleId, TEXT.staleRevision);
return;
}
var expiresAt = parseIsoTime(intent.expires_at);
if (expiresAt === null) {
setActionError(moduleId, TEXT.intentInvalid);
return;
}
if (expiresAt <= Date.now()) {
recordReceipt(intent, 'stale', 'EXPIRED_INTENT');
setActionError(moduleId, TEXT.expiredIntent);
return;
}
var knownDigest = viewRef.current.compositionDigest;
if (typeof knownDigest === 'string' && intent.composition_digest !== knownDigest) {
recordReceipt(intent, 'stale', 'DIGEST_MISMATCH');
setActionError(moduleId, TEXT.digestMismatch);
return;
}
if (intentsRef.current.has(intent.intent_id)) return;
rememberIntent(intent.intent_id);
if (intent.target.kind === 'panel') {
try {
ctx.layout.selectPanel(intent.target.panel_key);
} catch (error) {
recordReceipt(intent, 'unavailable', 'TARGET_UNREGISTERED');
setActionError(moduleId, TEXT.targetUnregistered);
return;
}
recordReceipt(intent, 'opened', null);
patchView(function () {
return {
actionError: null,
instruction: null,
notice: TEXT.opened + moduleLabel(moduleId) + '。',
};
});
return;
}
var instructionKey = intent.target.instruction_key;
var refText = intent.target.kind === 'skill' ? intent.target.skill_ref : intent.target.command_ref;
var instructionText = instructionTextFor(instructionKey);
var copyText = '按以下步骤手动打开 ' + moduleLabel(moduleId) + '：\n' + instructionText +
'\n' + TEXT.instructionKey + instructionKey + '\n' + TEXT.instructionRef + refText +
'\n' + TEXT.instructionSafety;
patchView(function () {
return {
actionError: null,
copyState: 'idle',
instruction: {
moduleId: moduleId,
kind: intent.target.kind,
instructionKey: instructionKey,
refText: refText,
text: instructionText,
copyText: copyText,
},
notice: null,
};
});
recordReceipt(intent, 'instruction_shown', null);
}

function dismissInstruction() {
patchView(function () {
return {instruction: null, copyState: 'idle'};
});
}

function copyInstruction() {
var latest = viewRef.current;
if (!latest.instruction) return;
var text = latest.instruction.copyText;
var finish = function (ok) {
patchView(function () {
return ok ? {copyState: 'copied'} : {copyState: 'failed'};
});
if (!ok) return;
if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
copyTimerRef.current = setTimeout(function () {
copyTimerRef.current = null;
patchView(function () {
return {copyState: 'idle'};
});
}, COPY_FEEDBACK_MS);
};
try {
if (typeof navigator !== 'undefined' && navigator !== null && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
navigator.clipboard.writeText(text).then(function () {
finish(true);
}, function () {
finish(false);
});
return;
}
} catch (error) {
finish(false);
return;
}
finish(false);
}

function toggleCompositionPanel() {
patchView(function (previous) {
var open = !previous.showComposition;
var composition = previous.composition;
if (open && (composition.selectedIds === null || composition.selectedIds.length === 0)) {
composition = assign({}, composition, {
selectedIds: previous.context !== null ? previous.context.selected_module_ids.slice() : [],
preview: null,
error: null,
});
}
return {showComposition: open, composition: composition};
});
}

function setCompositionError(text) {
patchView(function (previous) {
return {composition: assign({}, previous.composition, {busy: false, error: text})};
});
}

function toggleCompositionModule(moduleId, checked) {
var latest = viewRef.current;
if (!latest.showComposition) return;
var base = latest.composition.selectedIds !== null
? latest.composition.selectedIds.slice()
: latest.context !== null ? latest.context.selected_module_ids.slice() : [];
var index = base.indexOf(moduleId);
if (checked && index < 0) base.push(moduleId);
if (!checked && index >= 0) base.splice(index, 1);
base.sort();
patchView(function (previous) {
return {composition: assign({}, previous.composition, {selectedIds: base})};
});
requestCompositionPreview(base);
}

function requestCompositionPreview(selectedIds) {
var latest = viewRef.current;
if (!latest.context) return;
var context = latest.context;
compositionSeqRef.current += 1;
var seq = compositionSeqRef.current;
var requestEpoch = epochRef.current;
patchView(function (previous) {
return {composition: assign({}, previous.composition, {busy: true, error: null})};
});
var request = makeShell(context.context_ref, context.scope_generation, requestEpoch, {
profile_ref: context.profile_ref,
expected_revision: context.profile_revision,
selected_ids: selectedIds,
});
callRpc('composition.preview', request, undefined).then(function (result) {
if (seq !== compositionSeqRef.current) return;
if (requestEpoch !== epochRef.current) return;
var current = viewRef.current;
if (!current.context || current.context.context_ref !== context.context_ref) return;
if (result.kind === 'aborted') return;
if (result.kind === 'transport_failure') {
setCompositionError(TEXT.transportFailure);
return;
}
if (result.kind === 'protocol_failure') {
setCompositionError(TEXT.protocolFailure);
return;
}
if (result.kind === 'business_failure') {
setCompositionError(reasonText(result.reason_code));
return;
}
var preview = validatePreviewData(result.response.data);
if (preview === null) {
setCompositionError(TEXT.protocolFailure);
return;
}
var expiresAt = parseIsoTime(preview.expires_at);
if (expiresAt !== null && expiresAt <= Date.now()) {
setCompositionError(reasonText('STALE_PREVIEW'));
return;
}
patchView(function (previous) {
return {composition: assign({}, previous.composition, {busy: false, preview: preview, error: null})};
});
}, function () {
setCompositionError(TEXT.transportFailure);
});
}

useEffect(function () {
discoverContexts('mount');
return function () {
if (discoveryAbortRef.current !== null) {
try {
discoveryAbortRef.current.abort();
} catch (error) {
}
discoveryAbortRef.current = null;
}
abortStatusInFlight();
if (copyTimerRef.current !== null) {
clearTimeout(copyTimerRef.current);
copyTimerRef.current = null;
}
intentsRef.current.clear();
};
}, []);

var context = view.context;
var contextRef = context === null ? null : context.context_ref;
var contextGeneration = context === null ? null : context.scope_generation;
var contextRevision = context === null ? null : context.context_revision;

useEffect(function () {
if (contextRef === null || contextGeneration === null || view.phase !== 'ready') return undefined;
var disposed = false;
var pollTimer = null;

function poll() {
if (disposed) return;
if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
if (statusInFlightRef.current !== null) return;
var latest = viewRef.current;
if (!latest.context || latest.phase !== 'ready') return;
var requestEpoch = epochRef.current;
var input = {};
if (latest.status !== null && isInteger(latest.status.revision, 0)) input.after_revision = latest.status.revision;
var request = makeShell(latest.context.context_ref, latest.context.scope_generation, requestEpoch, input);
var controller = typeof AbortController === 'function' ? new AbortController() : null;
statusInFlightRef.current = controller;
var pollContext = latest.context;
callRpc('status.get', request, controller !== null ? controller.signal : undefined).then(function (result) {
if (statusInFlightRef.current === controller) statusInFlightRef.current = null;
if (disposed) return;
if (controller !== null && controller.signal.aborted) return;
if (requestEpoch !== epochRef.current) return;
applyStatusResult(request, pollContext, result);
});
}

function onVisibilityChange() {
if (typeof document === 'undefined') return;
if (document.visibilityState === 'hidden') {
abortStatusInFlight();
return;
}
poll();
}

if (typeof document !== 'undefined' && document.addEventListener) {
document.addEventListener('visibilitychange', onVisibilityChange);
}
pollTimer = setInterval(poll, POLL_INTERVAL_MS);
poll();
return function cleanup() {
disposed = true;
if (pollTimer !== null) {
clearInterval(pollTimer);
pollTimer = null;
}
if (typeof document !== 'undefined' && document.removeEventListener) {
document.removeEventListener('visibilitychange', onVisibilityChange);
}
abortStatusInFlight();
};
}, [contextRef, contextGeneration, contextRevision, view.phase, view.refreshNonce]);

useEffect(function () {
var error = view.actionError !== null ? view.actionError : null;
if (error === null) return undefined;
var node = errorSummaryRef.current;
if (node && typeof node.focus === 'function') node.focus();
return undefined;
}, [view.actionError, view.statusError, view.discoveryError]);

var texts = {
currentContext: TEXT.contextLabel,
notSelected: '尚未选择上下文',
session: TEXT.sessionLabel,
notBound: TEXT.notBound,
compositionRevision: TEXT.compositionRevisionLabel,
returnChat: TEXT.returnChat,
switchContext: TEXT.contextSwitch,
contextNavLabel: TEXT.contextNavLabel,
};

var phase = view.phase;
var errorText = null;
if (view.actionError !== null) errorText = view.actionError.text;
else if (view.statusError !== null) errorText = view.statusError;
else if (view.discoveryError !== null) errorText = view.discoveryError;
else if (view.composition.error !== null) errorText = view.composition.error;

var liveMessage = view.notice !== null ? view.notice : (view.status !== null ? TEXT.liveRefreshed : TEXT.liveIdle);

var modules = view.status !== null ? view.status.modules : [];
var catalog = view.catalog;
var diagnostics = view.status !== null ? view.status.diagnostics : [];
var selectedModuleIds = context !== null ? context.selected_module_ids : [];
var laterModules = [];
var laterSeen = {};
function addLaterModule(moduleId) {
if (laterSeen[moduleId] === true) return;
laterSeen[moduleId] = true;
if (!MODULE_ID.test(moduleId)) return;
if (selectedModuleIds.indexOf(moduleId) >= 0) return;
laterModules.push(moduleId);
}
KNOWN_LATER_MODULES.forEach(addLaterModule);
catalog.forEach(function (row) { addLaterModule(row.module_id); });

return el('div', {className: 'lw-root', 'data-lw-workbench': PANEL_KEY, lang: 'zh-CN'},
el(Header, {
context: context,
contexts: view.contexts,
fixtureMode: view.fixtureMode,
texts: texts,
onReturnToChat: returnToChat,
onSelectContext: chooseContext,
}),
el(LiveRegion, {message: liveMessage}),
el(ErrorSummary, {text: errorText, focusRef: errorSummaryRef}),

phase === 'discovering' ? el('p', {className: 'lw-muted'}, TEXT.discovering) : null,
phase === 'refreshing' ? el('p', {className: 'lw-muted'}, TEXT.refreshing) : null,
phase === 'blocked' ? el('div', {className: 'lw-blocked'},
el('p', null, TEXT.noContext),
el('p', {className: 'lw-meta'}, TEXT.noContextHint),
el('button', {type: 'button', className: 'lw-btn', onClick: retryDiscovery}, TEXT.retry)
) : null,
phase === 'failed' ? el('div', {className: 'lw-blocked'},
el('p', null, TEXT.noContext),
el('button', {type: 'button', className: 'lw-btn', onClick: retryDiscovery}, TEXT.retry)
) : null,
phase === 'choosing' ? el('section', {className: 'lw-section', 'aria-labelledby': 'lw-choosing-title'},
el('h2', {id: 'lw-choosing-title', className: 'lw-section-title'}, TEXT.choosingTitle),
el('p', null, TEXT.choosing),
el('ul', {className: 'lw-issues'}, view.contexts.map(function (entry) {
return el('li', {key: entry.context_ref},
el('button', {
type: 'button',
className: 'lw-btn',
onClick: function () { chooseContext(entry.context_ref); },
}, entry.label + '（' + entry.context_ref + '）')
);
}))
) : null,

phase === 'ready' && context !== null ? el(Fragment, null,
el('p', {className: 'lw-meta'}, TEXT.about),
view.statusError !== null ? el('div', {className: 'lw-alert'},
el('p', {className: 'lw-error', role: 'alert'}, view.statusError),
el('button', {type: 'button', className: 'lw-btn', onClick: refreshStatus}, el(RefreshIcon), ' ', TEXT.retryStatus)
) : null,
el('section', {className: 'lw-section', 'aria-labelledby': 'lw-modules-title'},
el('h2', {id: 'lw-modules-title', className: 'lw-section-title'}, TEXT.modulesTitle),
view.status === null ? el('p', {className: 'lw-muted'}, TEXT.modulesLoading) : null,
view.status !== null && modules.length === 0 ? el('p', {className: 'lw-muted'}, TEXT.modulesEmpty) : null,
view.status !== null && modules.length > 0 ? el('div', {className: 'lw-grid'}, modules.map(function (module) {
return el(ModuleCard, {
key: module.module_id,
module: module,
displayName: moduleDisplayName(catalog, module.module_id),
catalogRow: catalogRow(catalog, module.module_id),
busy: view.navBusyModule === module.module_id,
error: view.actionError !== null && view.actionError.moduleId === module.module_id ? view.actionError.text : null,
onOpen: openModule,
});
})) : null
),
el('section', {className: 'lw-section', 'aria-labelledby': 'lw-issues-title'},
el('h2', {id: 'lw-issues-title', className: 'lw-section-title'}, TEXT.issuesTitle),
(function () {
var issues = issuesFor(view);
return issues.length === 0
? el('p', {className: 'lw-muted'}, TEXT.issuesEmpty)
: el('ul', {className: 'lw-issues'}, issues.map(function (issue) {
return el('li', {key: issue.key}, issue.text);
}));
})()
),
el('details', {className: 'lw-section lw-later'},
el('summary', {className: 'lw-section-title'}, TEXT.laterTitle),
laterModules.length === 0
? el('p', {className: 'lw-muted'}, TEXT.laterEmpty)
: el('ul', null, laterModules.map(function (moduleId) {
var row = catalogRow(catalog, moduleId);
return el('li', {key: moduleId}, moduleDisplayName(catalog, moduleId) + '（' + moduleId + '）' + (row !== null ? ' · ' + row.release_version : '') + ' — ' + TEXT.laterHint);
}))
),
el(CompositionSection, {
context: context,
open: view.showComposition,
composition: view.composition,
diagnostics: diagnostics,
candidates: compositionCandidates(view),
onToggleOpen: toggleCompositionPanel,
onToggleModule: toggleCompositionModule,
})
) : null,

view.instruction !== null ? el(InstructionCard, {
instruction: view.instruction,
copyState: view.copyState,
onCopy: copyInstruction,
onClose: dismissInstruction,
}) : null
);
}

// plugin body
function apply(ctx) {
var scopedStyle = ensureStyle();
ctx.effect(function () {
return function () {
removeStyle(scopedStyle);
};
}, 'local-workbench: scoped styles');

ctx.effect(function () {
return ctx.slots.inject('main', function () {
return ctx.slots.register({name: 'main', key: PANEL_KEY}, function LocalWorkbenchSlot() {
return el(WorkbenchPanel, {ctx: ctx});
});
});
}, 'local-workbench: main panel');

ctx.effect(function () {
return ctx.slots.inject('sidebar.panellist', function () {
return ctx.slots.register({
name: 'sidebar.panellist',
id: PANEL_KEY,
order: 30,
label: function () { return PANEL_LABEL; },
}, WorkbenchIcon);
});
}, 'local-workbench: sidebar entry');
}

ensureStyle();

module.exports = {
name: PLUGIN_NAME,
inject: ['slots', 'layout', 'connection'],
apply: apply,
};
return module.exports;
},
});
