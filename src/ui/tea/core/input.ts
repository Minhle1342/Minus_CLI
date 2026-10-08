import type { KeyMsg } from '../types.js';
const sequences: Record<string, string> = {
  '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left',
  '\x1b[H': 'home', '\x1b[F': 'end', '\x1bOH': 'home', '\x1bOF': 'end',
  '\x1b[1~': 'home', '\x1b[4~': 'end', '\x1b[3~': 'delete', '\x1b[5~': 'pageup', '\x1b[6~': 'pagedown',
  '\x1b[13;2u': 'shift+enter', '\x1b\r': 'alt+enter', '\x1b[27;2;13~': 'shift+enter',
};
export class KeyDecoder {
  private pending = '';
  private paste = false;
  feed(data: string, now = Date.now()): KeyMsg[] {
    this.pending += data;
    const messages: KeyMsg[] = [];
    const key = (name: string, text?: string) => messages.push({ type: 'key', key: name, text, now });
    while (this.pending) {
      if (this.paste) {
        const end = this.pending.indexOf('\x1b[201~');
        if (end < 0) break;
        key('paste', this.pending.slice(0, end)); this.pending = this.pending.slice(end + 6); this.paste = false; continue;
      }
      if (this.pending.startsWith('\x1b[200~')) { this.paste = true; this.pending = this.pending.slice(6); continue; }
      if (this.pending[0] === '\x1b') {
        const sequence = Object.keys(sequences).find(sequence => this.pending.startsWith(sequence));
        if (sequence) { key(sequences[sequence]); this.pending = this.pending.slice(sequence.length); continue; }
        const mouse = this.pending.match(/^\x1b\[<([0-9]+);([0-9]+);([0-9]+)([Mm])/);
        if (mouse) {
          const wheel = Number(mouse[1]) & 0b11000011;
          if (mouse[4] === 'M' && (wheel === 64 || wheel === 65)) {
            messages.push({ type: 'key', key: wheel === 64 ? 'mouse+up' : 'mouse+down', mouse: { x: Number(mouse[2]), y: Number(mouse[3]) }, now });
          }
          this.pending = this.pending.slice(mouse[0].length); continue;
        }
        if (this.pending === '\x1b' || ['\x1b[200~', ...Object.keys(sequences)].some(sequence => sequence.startsWith(this.pending)) || /^\x1b\[[0-9;<]*$/.test(this.pending)) break;
        const unknown = this.pending.match(/^\x1b\[[0-?]*[ -/]*[@-~]/);
        if (unknown) { this.pending = this.pending.slice(unknown[0].length); continue; }
        key('escape'); this.pending = this.pending.slice(1); continue;
      }
      const char = String.fromCodePoint(this.pending.codePointAt(0)!);
      this.pending = this.pending.slice(char.length);
      const code = char.charCodeAt(0);
      if (char === '\r' || char === '\n') key('enter');
      else if (char === '\t') key('tab');
      else if (code === 127 || code === 8) key('backspace');
      else if (code === 0) key('ctrl+space');
      else if (code > 0 && code < 27) key('ctrl+' + String.fromCharCode(96 + code));
      else if (code >= 32) key(char.toLowerCase(), char);
    }
    return messages;
  }
  flushEscape(now = Date.now()): KeyMsg[] {
    if (this.pending !== '\x1b') return [];
    this.pending = ''; return [{ type: 'key', key: 'escape', now }];
  }
}
