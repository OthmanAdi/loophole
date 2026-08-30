/**
 * Licensed-SDK compile-time integration guard. This file has no runtime code and
 * emits no SDK declarations: it proves both the core port and the real adapter can
 * be passed to the published structural MCP boundary.
 */

import type { LiveBridge as PublicLiveBridge } from '@othmanadi/ableton-mcp';
import type { LiveBridge as CoreLiveBridge } from '@othmanadi/loophole-core';

import type { AbletonLiveBridge } from './live-bridge.ableton.js';

declare const coreBridge: CoreLiveBridge;
declare const abletonBridge: AbletonLiveBridge;

const coreBridgeIsPublic: PublicLiveBridge = coreBridge;
const abletonBridgeIsPublic: PublicLiveBridge = abletonBridge;

void coreBridgeIsPublic;
void abletonBridgeIsPublic;
