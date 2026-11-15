// Refuses web requests whose URL carries text the delegate read from granted files, so a
// prompt-injected page cannot get file contents sent to it in a query string, path or
// subdomain. It catches verbatim or lightly re-encoded text (URL encoding, case, spacing,
// punctuation); it does not catch encoded, compressed or paraphrased data. It narrows the
// web-plus-files risk; it does not remove it.

export const GUARD = { window: 24, step: 8, maxDecodes: 3 };
// Any shared run of at least window + step - 1 normalized characters is always detected;
// runs shorter than `window` never are, so short search phrases still work.

const URLS = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s"'<>()]+/gi;
const normalize = text => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export class LeakGuard {
  constructor() { this.windows = new Set(); this.blocked = 0; }

  // Indexes text returned to the delegate. URLs inside it are left out, so a delegate can
  // still fetch a link it found in a file.
  add(text) {
    const n = normalize(String(text).replace(URLS, ' '));
    for (let i = 0; i + GUARD.window <= n.length; i += GUARD.step) this.windows.add(n.slice(i, i + GUARD.window));
  }

  // True when the URL, after undoing URL encoding, contains an indexed run.
  leaks(url) {
    if (!this.windows.size) return false;
    let text = String(url);
    for (let i = 0; i < GUARD.maxDecodes; i++) {
      let next = text.replace(/\+/g, ' ');
      try { next = decodeURIComponent(next); } catch { next = next.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))); }
      if (next === text) break;
      text = next;
    }
    const n = normalize(text);
    for (let i = 0; i + GUARD.window <= n.length; i++) if (this.windows.has(n.slice(i, i + GUARD.window))) return true;
    return false;
  }
}
