/** Public engine API. Pure TypeScript: no React, three.js or DOM dependencies. */
export { Engine, type EngineOptions, type TraceListener } from './core/Engine';
export type { ScheduledEvent } from './core/EventQueue';
export { MS, SEC, US, formatDuration, formatTime } from './core/time';
export type { MtrOptions, PingOptions, TracerouteOptions } from './devices/Host';
export type * from './devices/state';
export { encodeFrame, type Frame } from './model/frame';
export * from './model/topology';
export * from './protocols/addr';
export type { FieldSpan, LayerName, LayerSpan } from './protocols/bytes';
export { classifyFrame, summarizeFrame, type PacketClass } from './protocols/describe';
export type { EncodedFrame } from './protocols/ethernet';
export * from './protocols/types';
export type * from './trace/events';
export { generatedMac } from './topology/build';
export { validateTopology, segmentsOf, type ValidationIssue } from './topology/validate';
