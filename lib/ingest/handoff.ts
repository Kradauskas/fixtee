/**
 * Handoffs to other roles. Stubs until the real functions land; swap the bodies for imports then.
 *
 * Contract (agreed with Role 2): before calling runAgent(errorId) we insert a `fixes` row with
 * status `queued` for that error. The agent looks that row up by error_id and updates it; it does
 * not create its own.
 */

/** Role 2: start the agent for an error. STUB: logs only. */
export async function runAgent(errorId: string): Promise<void> {
  console.info(`handoff: runAgent called (stub) ${JSON.stringify({ errorId })}`);
}
