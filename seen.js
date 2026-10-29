/**
 * Read receipts: the page is the only witness to whether a human was at the
 * screen when a reply landed.
 *
 * The page sees the turn finish (`running` going false) at the same moment the
 * host emits `turn/end`. From that instant on, any input the page receives was
 * made by a person — scrolling, clicking, typing — because the GUI's own
 * follow-the-output scrolling stops with the turn and raises none of those
 * events. A message is dropped when a receipt lands inside its idle window: the
 * user is already reading the very thing it would announce.
 *
 * Nothing here is a prediction. A receipt either arrived after the message was
 * held or it did not; a page nobody touched produces none, so silence always
 * means "send".
 */

/**
 * Build the receipts one plugin instance keeps.
 * @param now - clock, so a caller can age a receipt without waiting.
 * @returns `{ mark, since }`: record one act, then ask about a window.
 */
export function createSeen(now = Date.now) {
  /** When a human last acted in a session, keyed by session id. */
  const marks = new Map()

  /**
   * Record one act.
   * @param sessionId - the session the page was showing.
   * @returns `true` when the receipt was usable and stored, `false` when it was not.
   */
  function mark(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return false
    marks.set(sessionId, now())
    return true
  }

  /**
   * Whether a human acted in this session after the message was held. Strictly
   * after: the page only starts listening once the turn has finished, which is
   * after the host held the message, so a receipt that is not later than the hold
   * belongs to the previous turn.
   * @param sessionId - the session a pending message is about.
   * @param heldAt - the moment that message was held, in ms.
   */
  function since(sessionId, heldAt) {
    const at = marks.get(sessionId)
    return at !== undefined && at > heldAt
  }

  return { mark, since }
}
