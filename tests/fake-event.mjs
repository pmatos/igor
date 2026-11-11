export const ME = "@wanda:example.org";
export const NAMES = { [ME]: "Wanda", "@ana:example.org": "Ana", "@bo:example.org": "Bo" };
export class Ev {
  constructor(o) { this.o = o; }
  getType() { return this.o.type ?? "m.room.message"; }
  isRedacted() { return false; }
  isDecryptionFailure() { return false; }
  getContent() { return this.o.content; }
  getTs() { return this.o.origin_server_ts; }
  getId() { return this.o.event_id; }
  getSender() { return this.o.sender; }
  get sender() { return { name: NAMES[this.o.sender] }; }
}
