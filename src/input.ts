const encoder = new TextEncoder();

const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

function ctrlByte(letter: string): Uint8Array | null {
  if (letter.length !== 1) return null;
  const code = letter.toLowerCase().charCodeAt(0);
  if (code >= 97 && code <= 122) {
    return new Uint8Array([code - 96]);
  }
  if (letter === " ") return new Uint8Array([0]);
  if (letter === "[") return new Uint8Array([27]);
  if (letter === "]") return new Uint8Array([29]);
  if (letter === "\\") return new Uint8Array([28]);
  if (letter === "/") return new Uint8Array([31]);
  return null;
}

export function encodeKey(e: KeyboardEvent): Uint8Array | null {
  if (e.metaKey) return null;
  const key = e.key;

  if (e.ctrlKey && !e.altKey && key.length === 1) {
    const b = ctrlByte(key);
    if (b) return b;
  }

  let bytes: Uint8Array | null = null;
  switch (key) {
    case "Enter":
      bytes = new Uint8Array([0x0d]);
      break;
    case "Backspace":
      bytes = new Uint8Array([0x7f]);
      break;
    case "Tab":
      // Back-tab (CSI Z) — apps like Claude Code bind Shift+Tab; a bare
      // 0x09 is indistinguishable from plain Tab.
      bytes = e.shiftKey ? encoder.encode("\x1b[Z") : new Uint8Array([0x09]);
      break;
    case "Escape":
      bytes = new Uint8Array([0x1b]);
      break;
    case "ArrowUp":
      bytes = encoder.encode("\x1b[A");
      break;
    case "ArrowDown":
      bytes = encoder.encode("\x1b[B");
      break;
    case "ArrowRight":
      bytes = encoder.encode("\x1b[C");
      break;
    case "ArrowLeft":
      bytes = encoder.encode("\x1b[D");
      break;
    case "Home":
      bytes = encoder.encode("\x1b[H");
      break;
    case "End":
      bytes = encoder.encode("\x1b[F");
      break;
    case "PageUp":
      bytes = encoder.encode("\x1b[5~");
      break;
    case "PageDown":
      bytes = encoder.encode("\x1b[6~");
      break;
    case "Delete":
      bytes = encoder.encode("\x1b[3~");
      break;
    case "Insert":
      bytes = encoder.encode("\x1b[2~");
      break;
    case "F1":
      bytes = encoder.encode("\x1bOP");
      break;
    case "F2":
      bytes = encoder.encode("\x1bOQ");
      break;
    case "F3":
      bytes = encoder.encode("\x1bOR");
      break;
    case "F4":
      bytes = encoder.encode("\x1bOS");
      break;
    case "F5":
      bytes = encoder.encode("\x1b[15~");
      break;
    case "F6":
      bytes = encoder.encode("\x1b[17~");
      break;
    case "F7":
      bytes = encoder.encode("\x1b[18~");
      break;
    case "F8":
      bytes = encoder.encode("\x1b[19~");
      break;
    case "F9":
      bytes = encoder.encode("\x1b[20~");
      break;
    case "F10":
      bytes = encoder.encode("\x1b[21~");
      break;
    case "F11":
      bytes = encoder.encode("\x1b[23~");
      break;
    case "F12":
      bytes = encoder.encode("\x1b[24~");
      break;
    default:
      if (key.length === 1 && !e.ctrlKey) {
        bytes = encoder.encode(key);
      }
      break;
  }

  if (bytes && e.altKey) {
    // On macOS, Option composes special characters (Option+L → @, Option+5 → [, …).
    // The OS has already produced the composed glyph in e.key, so don't ESC-prefix it.
    // On other platforms, Alt+key is the conventional Meta-prefix (ESC + key).
    const isComposedChar = IS_MAC && key.length === 1;
    if (!isComposedChar) {
      const prefixed = new Uint8Array(bytes.length + 1);
      prefixed[0] = 0x1b;
      prefixed.set(bytes, 1);
      return prefixed;
    }
  }
  return bytes;
}
