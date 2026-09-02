/**
 * Scroll-follow decision logic for ChatView.
 *
 * Extracted as pure functions so the gesture-end follow-resume logic can be
 * unit-tested with real runtime execution (Jest). All functions are pure —
 * no side effects, no React dependencies.
 */

/**
 * Threshold (in pixels) below the gesture-start offset that qualifies the
 * gesture as containing a genuine user upward swipe. Must exceed typical
 * native over-scroll bounce noise (<5px) but stay below the smallest
 * deliberate user swipe (~20px+).
 */
export const SWIPE_UP_THRESHOLD = 10;

/**
 * Threshold (in pixels) of net downward movement required to classify a
 * gesture-end position as a "deliberate downward scroll". Gestures ending
 * with netDelta <= this value are treated as neutral (no deliberate down).
 */
export const NET_DOWN_THRESHOLD = 10;

/**
 * Detect whether the user's finger moved upward at any point during a
 * scroll gesture.
 *
 * WHY THIS EXISTS: During/after WS streaming, Android's native ScrollView
 * re-anchors offsetY FORWARD on every contentSize growth (native yank).
 * Multiple small native yanks (each <400px, evading Plan 5 detection)
 * accumulate forward motion, making the gesture-end `netDelta` read
 * positive/downward even when the user actually swiped up. Without this
 * detection, follow-resume would fire on a fake-positive netDelta and yank
 * the user back to the bottom.
 *
 * WHY gestureMinOffsetY IS SAFE: native yanks ONLY ever INCREASE offsetY
 * (forward re-anchor). They NEVER decrease it. So gestureMinOffsetY can
 * only drop below gestureStartOffsetY via genuine user upward motion.
 *
 * @param gestureMinOffsetY - The minimum offsetY reached during the gesture
 *   (tracked in handleScroll, reset in handleScrollBeginDrag).
 * @param gestureStartOffsetY - The offsetY at gesture start (recorded in
 *   handleScrollBeginDrag).
 * @returns true if the user swiped up at any point during this gesture.
 */
export function detectUserSwipedUp(
  gestureMinOffsetY: number,
  gestureStartOffsetY: number,
): boolean {
  return gestureMinOffsetY < gestureStartOffsetY - SWIPE_UP_THRESHOLD;
}

/**
 * Decide whether auto-follow should resume at gesture end.
 *
 * This is the core gate for follow-resume. It encodes ALL accumulated
 * root-cause fixes from rounds 7-10 + round 11 (current):
 *   - Round 7: require net DOWNWARD movement (netDelta > 10), not just
 *     nearBottom (WS content growth can make nearBottom=true after upward
 *     swipe).
 *   - Round 10: never resume if the user swiped up at any point during the
 *     gesture, even if netDelta reads positive (native yank accumulation
 *     makes netDelta unreliable post-stream).
 *   - Round 11 (current): REMOVED the `isStreaming` short-circuit that
 *     previously returned false unconditionally during WS streaming. That
 *     gate was the shared root cause of two bugs:
 *       1) After the user swipes up during a stream and then swipes back to
 *          the bottom, `shouldResumeFollow` still returned false (because
 *          streaming was active), so `wasNearBottom` could never recover
 *          until contentSize changed — meaning the post-stream scrollToEnd
 *          was skipped and the latest assistant content stayed hidden behind
 *          the input bar.
 *       2) Once `wasNearBottom` got stuck at false, the post-stream burst
 *          was correctly skipped, but no later event restored follow, so
 *          the view never re-anchored to bottom.
 *     The remaining 3 gates are sufficient to prevent false-positive resume:
 *     `userSwipedUp` is reliable (native yanks only ever increase offsetY),
 *     `netDelta > 10` filters out neutral gestures, and the optional
 *     `requireNearBottom && nearBottom` gate ensures deliberate down-scroll
 *     actually landed near the bottom.
 *
 * NOTE: `isStreaming` is kept in the params signature for call-site
 * stability and potential future instrumentation; it is intentionally NOT
 * used in the decision logic.
 *
 * @param params - Decision inputs
 * @param params.isStreaming - Whether WS streaming is active (currently
 *   unused by the decision logic; see note above)
 * @param params.userSwipedUp - Whether user's finger moved upward during
 *   this gesture (from detectUserSwipedUp)
 * @param params.netDelta - Net scroll offset change from gesture start to end
 * @param params.nearBottom - Whether the gesture-end position is near the
 *   bottom of content
 * @param params.requireNearBottom - handleMomentumScrollEnd requires
 *   nearBottom; handleScrollEndDrag (no-momentum path) does NOT (post-stream
 *   MD re-renders inflate contentSize faster than user can scroll, making
 *   nearBottom permanently false there).
 * @returns true if auto-follow should resume (wasNearBottom := true)
 */
export function shouldResumeFollow(params: {
  isStreaming: boolean;
  userSwipedUp: boolean;
  netDelta: number;
  nearBottom: boolean;
  requireNearBottom: boolean;
}): boolean {
  const { userSwipedUp, netDelta, nearBottom, requireNearBottom } = params;
  // Order matters for readability, not for short-circuit correctness (all
  // conditions are independent boolean checks).
  if (userSwipedUp) return false;
  if (netDelta <= NET_DOWN_THRESHOLD) return false;
  if (requireNearBottom && !nearBottom) return false;
  return true;
}
