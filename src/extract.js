// Injected into the Element tab with world: "MAIN". Must be self-contained:
// it is serialized by chrome.scripting.executeScript.
export async function extractRoom(limit) {
  const peg = window.mxMatrixClientPeg;
  const client =
    (peg && (peg.safeGet?.() ?? peg.get?.() ?? peg.matrixClient)) || null;
  if (!client) return { error: "no-client" };

  const match = location.hash.match(/#\/room\/([^/?]+)/);
  const ref = match ? decodeURIComponent(match[1]) : null;
  if (!ref) return { error: "no-room" };

  const room =
    client.getRoom(ref) ||
    client
      .getRooms()
      .find(
        (r) =>
          r.getCanonicalAlias() === ref || r.getAltAliases().includes(ref),
      );
  if (!room) return { error: "unknown-room", ref };

  const isMessage = (e) =>
    e.getType() === "m.room.message" &&
    !e.isRedacted() &&
    !e.isDecryptionFailure?.() &&
    typeof e.getContent().body === "string";

  // The live timeline can be a short window without a back token, so page
  // /messages directly from the newest event instead.
  let events = room.getLiveTimeline().getEvents().filter(isMessage);
  if (client.createMessagesRequest) {
    const mapper = client.getEventMapper();
    const fetched = [];
    let from = null;
    try {
      for (let i = 0; i < 10 && fetched.filter(isMessage).length < limit; i++) {
        const page = await client.createMessagesRequest(room.roomId, from, 100, "b");
        const batch = (page.chunk || []).map(mapper);
        await Promise.all(batch.map((e) => client.decryptEventIfNeeded?.(e)));
        fetched.push(...batch);
        from = page.end;
        if (!from || !batch.length) break;
      }
      events = fetched.filter(isMessage).sort((a, b) => a.getTs() - b.getTs());
    } catch {
      // fall back to whatever the live timeline holds
    }
  }

  const messages = events.slice(-limit).map((e) => ({
    ts: e.getTs(),
    sender: e.sender?.name || e.getSender(),
    body: e.getContent().body,
  }));

  return {
    roomId: room.roomId,
    name: room.name,
    topic: room.currentState?.getStateEvents("m.room.topic", "")?.getContent()
      ?.topic,
    memberCount: room.getJoinedMemberCount?.(),
    me: client.getUser?.(client.getUserId())?.displayName || client.getUserId(),
    messages,
  };
}
