/**
 * LiveKit service singleton — manages Room lifecycle for AI voice calls.
 *
 * Pattern follows tts-service.ts: lazy Room creation, event-driven state.
 * Self-hosted LiveKit server URL + token come from the backend API.
 */

import { Room, RoomEvent, Track, ConnectionState } from 'livekit-client';
import { AudioSession } from '@livekit/react-native';
import { api } from './api';

// ─── Agent state ──────────────────────────────────────────────

export type AgentState = 'connecting' | 'listening' | 'thinking' | 'speaking';

const AGENT_STATE_KEY = 'lk.agent.state';

const DISCONNECT_REASON_NAMES: Record<number, string> = {
  0: 'UNKNOWN_REASON',
  1: 'CLIENT_INITIATED',
  2: 'DUPLICATE_IDENTITY',
  3: 'SERVER_SHUTDOWN',
  4: 'PARTICIPANT_REMOVED',
  5: 'ROOM_DELETED',
  6: 'STATE_MISMATCH',
  7: 'JOIN_FAILURE',
  9: 'SIGNAL_CLOSE',
  10: 'ROOM_CLOSED',
  11: 'USER_UNAVAILABLE',
};

// ─── User speaking state ──────────────────────────────────────
// Derived from LiveKit server's ActiveSpeakersChanged event, which
// uses server-side audio energy detection on the local participant's
// published mic track. On iOS Simulator (no mic track published) this
// stays false — that's a known limitation, not a bug.

// ─── Types ────────────────────────────────────────────────────

export interface LiveKitTokenResponse {
  token: string;
  wsUrl: string;
}

export type VoiceConnectionState = ConnectionState;

interface LiveKitServiceState {
  room: Room | null;
  isAudioSessionStarted: boolean;
}

// ─── Singleton ────────────────────────────────────────────────

const state: LiveKitServiceState = {
  room: null,
  isAudioSessionStarted: false,
};

// LiveKit may misfire Reconnected during airplane mode. After Reconnecting,
// we wait 5s for genuine recovery (ParticipantConnected / TranscriptionReceived)
// before propagating Connected. Cleared on full disconnect.
let reconnectSuspect = false;
let reconnectConfirmTimer: ReturnType<typeof setTimeout> | null = null;

/** Clear reconnect-suspect flag and propagate Connected if we were in suspect window. */
function confirmReconnectIfSuspect(): void {
  if (!reconnectSuspect) return;
  reconnectSuspect = false;
  if (reconnectConfirmTimer) {
    clearTimeout(reconnectConfirmTimer);
    reconnectConfirmTimer = null;
  }
  console.log('[livekit] Reconnect confirmed by genuine activity — propagating Connected');
  notifyStateListeners(ConnectionState.Connected);
}

// Event listeners registry — allows store/hooks to subscribe
type StateListener = (state: VoiceConnectionState) => void;
type MicListener = (enabled: boolean) => void;
type ScreenShareListener = (enabled: boolean) => void;
type CameraListener = (enabled: boolean) => void;
type ParticipantListener = (identity: string | undefined) => void;
type AgentStateListener = (state: AgentState) => void;
type AmplitudeListener = (amplitude: number) => void;
type ErrorListener = (error: string | null) => void;
type UserSpeakingListener = (speaking: boolean) => void;

const stateListeners = new Set<StateListener>();
const micListeners = new Set<MicListener>();
const screenShareListeners = new Set<ScreenShareListener>();
const cameraListeners = new Set<CameraListener>();
const agentListeners = new Set<ParticipantListener>();
const agentStateListeners = new Set<AgentStateListener>();
const amplitudeListeners = new Set<AmplitudeListener>();
const errorListeners = new Set<ErrorListener>();
const userSpeakingListeners = new Set<UserSpeakingListener>();

function notifyStateListeners(cs: VoiceConnectionState) {
  stateListeners.forEach((fn) => fn(cs));
}

function notifyMicListeners(enabled: boolean) {
  micListeners.forEach((fn) => fn(enabled));
}

function notifyScreenShareListeners(enabled: boolean) {
  screenShareListeners.forEach((fn) => fn(enabled));
}

function notifyCameraListeners(enabled: boolean) {
  cameraListeners.forEach((fn) => fn(enabled));
}

function notifyAgentListeners(identity?: string) {
  agentListeners.forEach((fn) => fn(identity));
}

function notifyAgentStateListeners(agentState: AgentState) {
  agentStateListeners.forEach((fn) => fn(agentState));
}

function notifyAmplitudeListeners(amplitude: number) {
  amplitudeListeners.forEach((fn) => fn(amplitude));
}

function notifyErrorListeners(error: string | null) {
  errorListeners.forEach((fn) => fn(error));
}

function notifyUserSpeakingListeners(speaking: boolean) {
  userSpeakingListeners.forEach((fn) => fn(speaking));
}

// ─── Transcript listener registry ──────────────────────────────

type TranscriptRole = 'user' | 'assistant';
type TranscriptHandler = (
  segmentId: string,
  role: TranscriptRole,
  text: string,
  isFinal: boolean,
) => void;

const transcriptListeners = new Set<TranscriptHandler>();

function notifyTranscriptListeners(
  segmentId: string,
  role: TranscriptRole,
  text: string,
  isFinal: boolean,
) {
  transcriptListeners.forEach((cb) => {
    try {
      cb(segmentId, role, text, isFinal);
    } catch (e) {
      console.warn('[lk] transcript listener error:', e);
    }
  });
}

// ─── Public API ───────────────────────────────────────────────

/**
 * Fetch a LiveKit token from the backend.
 * The backend generates a JWT with room join grants and agent dispatch.
 */
export async function fetchLiveKitToken(): Promise<LiveKitTokenResponse> {
  const res = await api.post<{ token: string; wsUrl: string }>('/api/livekit/token');
  return { token: res.token, wsUrl: res.wsUrl };
}

/**
 * Create a Room with the full set of event listeners attached.
 * Used by both `connectToRoom` (eager path) and `prepareConnection`
 * (warm-up path) so listener registration can never be skipped when
 * the two share the same `state.room` instance.
 */
function createConfiguredRoom(): Room {
  const room = new Room({
    adaptiveStream: false,
    dynacast: false,
    audioCaptureDefaults: {
      noiseSuppression: true,
      echoCancellation: true,
      autoGainControl: true,
    },
  });

  room.on(RoomEvent.ConnectionStateChanged, (cs: ConnectionState) => {
    notifyStateListeners(cs);
  });

  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind === Track.Kind.Audio) {
      // Remote audio (AI agent voice) — automatically played by LiveKit
    }
  });

  room.on(RoomEvent.Connected, () => {
    // Fallback for agent presence: if the Agent (JT_ROOM) joined before we
    // connected, ParticipantConnected may never fire for it. Scan the already
    // present remote participants so agentIdentity/agentState are populated
    // even when the ideal ordering is missed.
    for (const [, p] of room.remoteParticipants) {
      if (p.identity === room.localParticipant?.identity) continue;
      notifyAgentListeners(p.identity);
      const s = p.attributes?.[AGENT_STATE_KEY];
      if (s) notifyAgentStateListeners(castAgentState(s));
    }
  });

  room.on(RoomEvent.ParticipantConnected, (participant) => {
    confirmReconnectIfSuspect();
    notifyAgentListeners(participant.identity);
    const attrState = participant.attributes?.[AGENT_STATE_KEY];
    if (attrState) {
      notifyAgentStateListeners(castAgentState(attrState));
    }
  });

  room.on(RoomEvent.ParticipantDisconnected, (participant) => {
    if (participant.identity !== room.localParticipant?.identity) {
      notifyAgentListeners(undefined);
      notifyAgentStateListeners('connecting');
    }
  });

  room.on(
    RoomEvent.ParticipantAttributesChanged,
    (changedAttrs, participant) => {
      const next = changedAttrs?.[AGENT_STATE_KEY];
      if (next && participant.identity !== room.localParticipant?.identity) {
        notifyAgentStateListeners(castAgentState(next));
      }
    },
  );

  room.on(RoomEvent.TrackMuted, (publication, participant) => {
    if (participant.identity !== room.localParticipant?.identity) return;
    if (publication.source === Track.Source.Microphone) notifyMicListeners(false);
    if (publication.source === Track.Source.Camera) notifyCameraListeners(false);
  });

  room.on(RoomEvent.TrackUnmuted, (publication, participant) => {
    if (participant.identity !== room.localParticipant?.identity) return;
    if (publication.source === Track.Source.Microphone) notifyMicListeners(true);
    if (publication.source === Track.Source.Camera) notifyCameraListeners(true);
  });

  // Screen share is "on" when the track exists (not merely unmuted). The OS
  // stop-sharing chip unpublishes rather than muting.
  room.on(RoomEvent.LocalTrackPublished, (publication) => {
    if (publication.source === Track.Source.ScreenShare) notifyScreenShareListeners(true);
    if (publication.source === Track.Source.Camera) notifyCameraListeners(true);
  });

  room.on(RoomEvent.LocalTrackUnpublished, (publication) => {
    if (publication.source === Track.Source.ScreenShare) notifyScreenShareListeners(false);
    if (publication.source === Track.Source.Camera) notifyCameraListeners(false);
  });

  room.on(RoomEvent.Disconnected, (reason?: number) => {
    reconnectSuspect = false;
    if (reconnectConfirmTimer) {
      clearTimeout(reconnectConfirmTimer);
      reconnectConfirmTimer = null;
    }
    notifyStateListeners(ConnectionState.Disconnected);
    // 1 = CLIENT_INITIATED (user hangup — no error)
    // 0 = UNKNOWN_REASON (likely network drop)
    // 3 = SERVER_SHUTDOWN, 10 = ROOM_CLOSED, 6 = STATE_MISMATCH, 7 = JOIN_FAILURE (server issues)
    if (reason !== undefined && reason !== 1) {
      const reasonName = DISCONNECT_REASON_NAMES[reason] || `REASON_${reason}`;
      notifyErrorListeners(`Disconnected: ${reasonName}`);
    }
  });

  room.on(RoomEvent.MediaDevicesError, (err: Error) => {
    notifyErrorListeners(err?.message || 'Microphone device error');
  });

  room.on(RoomEvent.Reconnecting, () => {
    reconnectSuspect = true;
    notifyStateListeners(ConnectionState.Reconnecting);
  });

  room.on(RoomEvent.Reconnected, () => {
    // Don't blindly trust SDK's Reconnected — airplane mode reproduces a
    // case where SDK fires Reconnected but no real connection is alive.
    // Hold the Reconnecting state for 5s; if genuine activity arrives
    // (ParticipantConnected / TranscriptionReceived) the flag is cleared
    // earlier by those handlers and we propagate Connected here.
    if (reconnectSuspect) {
      console.log('[livekit] Reconnected during suspect window — deferring Connected propagation');
      if (reconnectConfirmTimer) clearTimeout(reconnectConfirmTimer);
      reconnectConfirmTimer = setTimeout(() => {
        reconnectSuspect = false;
        reconnectConfirmTimer = null;
        console.log('[livekit] Reconnect confirmation timeout — propagating Connected');
        notifyStateListeners(ConnectionState.Connected);
      }, 5000);
    } else {
      notifyStateListeners(ConnectionState.Connected);
    }
  });

  room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
    const localId = room.localParticipant?.identity;
    const localSpeaking = Array.isArray(speakers)
      ? speakers.some((p) => p.identity === localId)
      : false;
    notifyUserSpeakingListeners(localSpeaking);
  });

  room.registerTextStreamHandler(
    'lk.transcription',
    async (reader, participantInfo) => {
      try {
        const attrs = reader.info.attributes ?? {};
        const segmentId = (attrs['lk.segment_id'] as string) ?? reader.info.id;
        const isFinal = attrs['lk.transcription_final'] === 'true';

        let raw = await reader.readAll();
        let text = raw;
        if (raw && raw.trimStart().startsWith('{')) {
          try {
            const parsed = JSON.parse(raw);
            if (typeof parsed?.text === 'string') text = parsed.text;
          } catch {
            // not JSON — keep raw text
          }
        }

        text = text.trim();
        if (!text) {
          return;
        }

        const localIdentity = state.room?.localParticipant?.identity;
        const role: TranscriptRole =
          participantInfo?.identity === localIdentity ? 'user' : 'assistant';

        notifyTranscriptListeners(segmentId, role, text, isFinal);
        confirmReconnectIfSuspect();
      } catch (e) {
        console.warn('[lk] transcription handler error:', e);
      }
    },
  );

  return room;
}

/**
 * Connect to a LiveKit room.
 * Configures and starts the audio session, then connects the Room.
 */
export async function connectToRoom(wsUrl: string, token: string): Promise<Room> {
  // Configure audio session for communication mode (bidirectional voice)
  await AudioSession.configureAudio({
    android: {
      audioTypeOptions: {
        manageAudioFocus: true,
        audioMode: 'inCommunication',
        audioFocusMode: 'gain',
        audioStreamType: 'voiceCall',
        audioAttributesUsageType: 'voiceCommunication',
        audioAttributesContentType: 'speech',
      },
    },
    ios: {
      defaultOutput: 'speaker',
    },
  });

  if (!state.isAudioSessionStarted) {
    await AudioSession.startAudioSession();
    state.isAudioSessionStarted = true;
  }

  // Create or reuse Room
  if (!state.room) {
    state.room = createConfiguredRoom();
  }

  await state.room.connect(wsUrl, token);

  await state.room.localParticipant.setMicrophoneEnabled(true, {
    echoCancellation: true,
    noiseSuppression: true
  }, {
    preConnectBuffer: true,
  });

  return state.room;
}

/**
 * Disconnect from the current room.
 * Stops audio session and cleans up.
 */
export async function disconnectRoom(): Promise<void> {
  reconnectSuspect = false;
  if (reconnectConfirmTimer) {
    clearTimeout(reconnectConfirmTimer);
    reconnectConfirmTimer = null;
  }
  if (state.room) {
    const lp = state.room.localParticipant;
    try {
      if (lp.isScreenShareEnabled) await lp.setScreenShareEnabled(false);
    } catch {
      // Best-effort — hangup must still proceed if MediaProjection is already gone.
    }
    try {
      if (lp.isCameraEnabled) await lp.setCameraEnabled(false);
    } catch {
      // same
    }
    await state.room.disconnect();
  }
  if (state.isAudioSessionStarted) {
    await AudioSession.stopAudioSession();
    state.isAudioSessionStarted = false;
  }
  state.room = null;
  notifyStateListeners(ConnectionState.Disconnected);
  notifyAgentListeners(undefined);
  notifyErrorListeners(null);
  notifyUserSpeakingListeners(false);
  notifyScreenShareListeners(false);
  notifyCameraListeners(false);
}

/**
 * Toggle microphone on/off.
 */
export async function toggleMicrophone(): Promise<boolean> {
  if (!state.room) return false;
  await state.room.localParticipant.setMicrophoneEnabled(
    !state.room.localParticipant.isMicrophoneEnabled
  );
  return state.room.localParticipant.isMicrophoneEnabled;
}

/**
 * Publish or stop the local screen-share video track. On Android this
 * opens the system MediaProjection picker; the extra video stream is
 * sent to the same LiveKit room the AI agent already occupies.
 */
export async function toggleScreenShare(): Promise<boolean> {
  if (!state.room) return false;
  await state.room.localParticipant.setScreenShareEnabled(
    !state.room.localParticipant.isScreenShareEnabled,
  );
  return state.room.localParticipant.isScreenShareEnabled;
}

/**
 * Publish or stop the local camera video track.
 */
export async function toggleCamera(): Promise<boolean> {
  if (!state.room) return false;
  await state.room.localParticipant.setCameraEnabled(
    !state.room.localParticipant.isCameraEnabled,
  );
  return state.room.localParticipant.isCameraEnabled;
}

/**
 * Get current Room instance (may be null if not connected).
 */
export function getRoom(): Room | null {
  return state.room;
}

/**
 * Warm up the WebSocket and ICE connection before the user actually
 * presses connect. Call this from the moment the user *indicates* intent
 * (e.g. taps the dial button that opens the call modal) — by the time
 * `connectToRoom` is called, the signal socket and ICE candidates are
 * already in flight, eliminating 200-1000ms of first-call latency.
 *
 * Ensures `state.room` is fully initialized with all event listeners
 * (same path as `connectToRoom`) so a subsequent `connectToRoom` call
 * reuses this prepared room without skipping listener registration.
 */
export async function prepareConnection(wsUrl: string, token: string): Promise<void> {
  if (!state.room) {
    state.room = createConfiguredRoom();
  }
  try {
    await state.room.prepareConnection(wsUrl, token);
  } catch {
    // prepareConnection failures are non-fatal — connect() will retry.
  }
}

/**
 * Subscribe to connection state changes.
 * Returns an unsubscribe function.
 */
export function onConnectionStateChange(fn: StateListener): () => void {
  stateListeners.add(fn);
  return () => stateListeners.delete(fn);
}

/**
 * Subscribe to microphone enabled/disabled changes.
 */
export function onMicEnabledChange(fn: MicListener): () => void {
  micListeners.add(fn);
  return () => micListeners.delete(fn);
}

/**
 * Subscribe to local screen-share start/stop.
 */
export function onScreenShareEnabledChange(fn: ScreenShareListener): () => void {
  screenShareListeners.add(fn);
  return () => screenShareListeners.delete(fn);
}

/**
 * Subscribe to local camera enabled/disabled changes.
 */
export function onCameraEnabledChange(fn: CameraListener): () => void {
  cameraListeners.add(fn);
  return () => cameraListeners.delete(fn);
}

/**
 * Subscribe to AI agent participant join/leave.
 */
export function onAgentPresenceChange(fn: ParticipantListener): () => void {
  agentListeners.add(fn);
  return () => agentListeners.delete(fn);
}

/**
 * Subscribe to agent state changes (listening/thinking/speaking/connecting).
 */
export function onAgentStateChange(fn: AgentStateListener): () => void {
  agentStateListeners.add(fn);
  return () => agentStateListeners.delete(fn);
}

/**
 * Subscribe to local mic amplitude updates (0..1) for waveform rendering.
 * Updates fire roughly every 50ms while connected.
 */
export function onAmplitudeChange(fn: AmplitudeListener): () => void {
  amplitudeListeners.add(fn);
  return () => amplitudeListeners.delete(fn);
}

/**
 * Subscribe to media device errors (mic permission revoked, device
 * unplugged, OS audio session interrupted by another app, etc.). The
 * LiveKit SDK surfaces these via RoomEvent.MediaDevicesError; we
 * re-emit as a string so the UI can show a user-friendly message.
 */
export function onErrorChange(fn: ErrorListener): () => void {
  errorListeners.add(fn);
  return () => errorListeners.delete(fn);
}

/**
 * Subscribe to local user speaking state. Source of truth is the
 * LiveKit server's ActiveSpeakersChanged event, which performs
 * server-side audio energy detection on the published mic track.
 */
export function onUserSpeakingChange(fn: UserSpeakingListener): () => void {
  userSpeakingListeners.add(fn);
  return () => userSpeakingListeners.delete(fn);
}

export function onTranscript(handler: TranscriptHandler): () => void {
  transcriptListeners.add(handler);
  return () => transcriptListeners.delete(handler);
}

function castAgentState(raw: string): AgentState {
  if (raw === 'listening' || raw === 'thinking' || raw === 'speaking') return raw;
  return 'connecting';
}

// ─── Local mic amplitude metering ─────────────────────────────
// Drives the waveform visualiser in VoiceCallModal. Uses a dedicated
// metering-only AudioRecorder so it works regardless of whether the
// LiveKit mic track is actually publishing (iOS Simulator case).
//
// On platforms where expo-audio can't run (e.g. web), startMetering /
// stopMetering are no-ops and the amplitude stays at 0 — the waveform
// sits at its idle baseline, exactly like ChatInputBar on web.

let meteringRecorder: any | null = null;
let meteringTimer: ReturnType<typeof setInterval> | null = null;

function dbToAmplitude(db: number): number {
  if (!Number.isFinite(db) || db <= -60) return 0;
  if (db >= 0) return 1;
  return Math.sqrt((db + 60) / 60);
}

export async function startMetering(): Promise<void> {
  if (meteringRecorder) return;
  try {
    // Do NOT call expo-audio setAudioModeAsync here — it overwrites the
    // AudioManager state that LiveKit's AudioSwitch just activated, which
    // silently routes audio back to the loudspeaker even when a Bluetooth
    // headset is connected.
    const {
      AudioModule,
      IOSOutputFormat,
      AudioQuality,
    } = await import('expo-audio');
    const recorder = new AudioModule.AudioRecorder({
      numberOfChannels: 1,
      bitRate: 256000,
      isMeteringEnabled: true,
      android: {
        outputFormat: 'aac_adts' as const,
        audioEncoder: 'aac' as const,
        extension: '.m4a',
      },
      ios: {
        extension: '.caf',
        outputFormat: IOSOutputFormat.LINEARPCM,
        audioQuality: AudioQuality.HIGH,
        sampleRate: 16000,
        linearPCMBitDepth: 16,
        linearPCMIsBigEndian: false,
        linearPCMIsFloat: false,
      },
    });
    await recorder.prepareToRecordAsync();
    recorder.record();
    meteringRecorder = recorder;
    console.log('[metering] recorder started');
    let pollCount = 0;
    meteringTimer = setInterval(async () => {
      const rec = meteringRecorder;
      if (!rec) return;
      try {
        const status = await rec.getStatus();
        pollCount++;
        if (pollCount <= 3 || pollCount % 20 === 0) {
          console.log('[metering] poll #', pollCount, 'metering=', status.metering, 'isRecording=', status.isRecording);
        }
        if (typeof status.metering === 'number') {
          notifyAmplitudeListeners(dbToAmplitude(status.metering));
        }
      } catch (e: any) {
        console.warn('[metering] poll error:', e?.message);
      }
    }, 50);
  } catch (err) {
    console.warn('[livekit-service] startMetering failed:', err);
  }
}

export async function stopMetering(): Promise<void> {
  if (meteringTimer) {
    clearInterval(meteringTimer);
    meteringTimer = null;
  }
  if (meteringRecorder) {
    try {
      await meteringRecorder.stop();
    } catch {
      // ignore
    }
    meteringRecorder = null;
  }
  notifyAmplitudeListeners(0);
}
