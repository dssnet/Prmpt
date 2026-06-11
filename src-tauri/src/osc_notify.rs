//! Observe-only scanner for OSC desktop-notification sequences.
//!
//! Claude Code (and other CLIs) announce "task finished / needs attention"
//! with `OSC 9 ; message` (iTerm2 style) or `OSC 777 ; notify ; title ;
//! body` (Ghostty/urxvt style). libghostty-vt recognizes these internally
//! (`CommandType::ShowDesktopNotification`) but its Rust API doesn't expose
//! the title/body payload, so the tab loop runs each PTY chunk through this
//! scanner *before* `vt_write`. The scanner never consumes or modifies
//! bytes — the engine still parses the full stream — and it is stateful
//! because an escape sequence can split across the 8 KB PTY read chunks.

/// A parsed OSC 9 / OSC 777 notification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OscNotification {
    pub title: Option<String>,
    pub body: Option<String>,
}

/// Cap on the buffered OSC payload. Anything longer is truncated (we still
/// track the sequence to its terminator so parser state stays in sync, but
/// only the first 4 KB can become notification text).
const MAX_OSC_BUF: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Ground,
    Esc,
    Osc,
    OscEsc,
}

pub struct OscNotifyScanner {
    state: State,
    buf: Vec<u8>,
}

impl OscNotifyScanner {
    pub fn new() -> Self {
        Self {
            state: State::Ground,
            buf: Vec::new(),
        }
    }

    /// Feed one PTY chunk; returns any notifications whose sequences
    /// completed within it. A bare BEL in ground state is *not* reported
    /// here — that's the engine's `on_bell` callback's job.
    pub fn scan(&mut self, bytes: &[u8]) -> Vec<OscNotification> {
        let mut out = Vec::new();
        for &b in bytes {
            match self.state {
                State::Ground => {
                    if b == 0x1b {
                        self.state = State::Esc;
                    }
                }
                State::Esc => {
                    self.state = match b {
                        b']' => {
                            self.buf.clear();
                            State::Osc
                        }
                        0x1b => State::Esc,
                        _ => State::Ground,
                    };
                }
                State::Osc => match b {
                    0x07 => {
                        if let Some(n) = self.finalize() {
                            out.push(n);
                        }
                        self.state = State::Ground;
                    }
                    0x1b => self.state = State::OscEsc,
                    _ => {
                        if self.buf.len() < MAX_OSC_BUF {
                            self.buf.push(b);
                        }
                    }
                },
                State::OscEsc => match b {
                    // ST (ESC \) terminates the OSC.
                    b'\\' => {
                        if let Some(n) = self.finalize() {
                            out.push(n);
                        }
                        self.state = State::Ground;
                    }
                    // ESC ] right after an aborting ESC starts a new OSC.
                    b']' => {
                        self.buf.clear();
                        self.state = State::Osc;
                    }
                    // Any other escape aborts the OSC (per spec, a lone ESC
                    // cancels the string).
                    _ => self.state = State::Ground,
                },
            }
        }
        out
    }

    fn finalize(&mut self) -> Option<OscNotification> {
        let payload = String::from_utf8_lossy(&self.buf).into_owned();
        self.buf.clear();
        let (code, rest) = payload.split_once(';')?;
        match code {
            // OSC 9: the whole remainder is the message (semicolons included).
            "9" => Some(OscNotification {
                title: None,
                body: Some(rest.to_string()),
            }),
            // OSC 777: `notify;TITLE;BODY` — BODY may contain semicolons,
            // and may be absent entirely.
            "777" => {
                let (kind, args) = rest.split_once(';')?;
                if kind != "notify" {
                    return None;
                }
                let (title, body) = match args.split_once(';') {
                    Some((t, b)) => (t.to_string(), Some(b.to_string())),
                    None => (args.to_string(), None),
                };
                Some(OscNotification {
                    title: Some(title),
                    body,
                })
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(title: Option<&str>, body: Option<&str>) -> OscNotification {
        OscNotification {
            title: title.map(str::to_string),
            body: body.map(str::to_string),
        }
    }

    #[test]
    fn osc9_bel_terminated() {
        let mut s = OscNotifyScanner::new();
        let got = s.scan(b"\x1b]9;hello world\x07");
        assert_eq!(got, vec![note(None, Some("hello world"))]);
    }

    #[test]
    fn osc777_with_title_and_body() {
        let mut s = OscNotifyScanner::new();
        let got = s.scan(b"\x1b]777;notify;Claude Code;Task finished\x07");
        assert_eq!(got, vec![note(Some("Claude Code"), Some("Task finished"))]);
    }

    #[test]
    fn osc777_st_terminated_and_semicolons_in_body() {
        let mut s = OscNotifyScanner::new();
        let got = s.scan(b"\x1b]777;notify;T;a;b;c\x1b\\");
        assert_eq!(got, vec![note(Some("T"), Some("a;b;c"))]);
    }

    #[test]
    fn osc777_title_only() {
        let mut s = OscNotifyScanner::new();
        let got = s.scan(b"\x1b]777;notify;Just a title\x07");
        assert_eq!(got, vec![note(Some("Just a title"), None)]);
    }

    #[test]
    fn split_across_chunks_byte_at_a_time() {
        let mut s = OscNotifyScanner::new();
        let seq = b"\x1b]777;notify;Sp;lit\x07";
        let mut got = Vec::new();
        for &b in seq.iter() {
            got.extend(s.scan(&[b]));
        }
        assert_eq!(got, vec![note(Some("Sp"), Some("lit"))]);
    }

    #[test]
    fn non_notify_osc_ignored() {
        let mut s = OscNotifyScanner::new();
        // Title change (OSC 0), color query (OSC 10), 777 without notify.
        assert!(s.scan(b"\x1b]0;window title\x07").is_empty());
        assert!(s.scan(b"\x1b]10;?\x07").is_empty());
        assert!(s.scan(b"\x1b]777;other;x\x07").is_empty());
        // Scanner is back in ground and still works.
        assert_eq!(s.scan(b"\x1b]9;ok\x07"), vec![note(None, Some("ok"))]);
    }

    #[test]
    fn plain_text_and_bare_bel_produce_nothing() {
        let mut s = OscNotifyScanner::new();
        assert!(s.scan(b"hello\x07world\x1b[31mred\x1b[0m").is_empty());
    }

    #[test]
    fn oversized_payload_is_truncated_not_lost() {
        let mut s = OscNotifyScanner::new();
        let mut seq = b"\x1b]9;".to_vec();
        seq.extend(std::iter::repeat(b'x').take(MAX_OSC_BUF * 2));
        seq.push(0x07);
        let got = s.scan(&seq);
        assert_eq!(got.len(), 1);
        let body = got[0].body.as_deref().unwrap();
        // "9;" counts toward the buffer, so the body is bounded but present.
        assert!(body.len() <= MAX_OSC_BUF);
        assert!(body.starts_with("xxx"));
        // State machine resynced: a following sequence still parses.
        assert_eq!(s.scan(b"\x1b]9;ok\x07"), vec![note(None, Some("ok"))]);
    }

    #[test]
    fn esc_aborts_osc() {
        let mut s = OscNotifyScanner::new();
        // ESC followed by a CSI mid-OSC abandons the notification.
        assert!(s.scan(b"\x1b]9;abandoned\x1b[31m").is_empty());
        assert_eq!(s.scan(b"\x1b]9;ok\x07"), vec![note(None, Some("ok"))]);
    }
}
