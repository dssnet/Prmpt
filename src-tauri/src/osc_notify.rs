//! Observe-only scanner for OSC sequences the engine's Rust API doesn't
//! expose: desktop notifications and shell-integration cwd reports.
//!
//! Claude Code (and other CLIs) announce "task finished / needs attention"
//! with `OSC 9 ; message` (iTerm2 style) or `OSC 777 ; notify ; title ;
//! body` (Ghostty/urxvt style). libghostty-vt recognizes these internally
//! (`CommandType::ShowDesktopNotification`) but its Rust API doesn't expose
//! the title/body payload, so the tab loop runs each PTY chunk through this
//! scanner *before* `vt_write`. The scanner never consumes or modifies
//! bytes — the engine still parses the full stream — and it is stateful
//! because an escape sequence can split across the 8 KB PTY read chunks.
//!
//! Cwd reports come in two dialects: `OSC 7 ; file://host/path` (the
//! cross-platform shell-integration convention) and `OSC 9 ; 9 ; path`
//! (ConEmu/Windows Terminal — what pwsh profiles emit on Windows). The C
//! API's stream handler treats `report_pwd` as a no-op, so `Terminal::pwd()`
//! never learns it; this scanner is what feeds the tab's `osc_cwd` and,
//! through it, `terminal_cwd` (git panel, saved-workspace snapshots).

/// A parsed OSC 9 / OSC 777 notification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OscNotification {
    pub title: Option<String>,
    pub body: Option<String>,
}

/// Everything extracted from one PTY chunk.
#[derive(Debug, Default)]
pub struct OscScan {
    pub notifications: Vec<OscNotification>,
    /// Latest cwd report in the chunk — OSC 7 (`file://` URI, decoded to a
    /// plain path) or OSC 9;9 (path verbatim, quotes stripped). Parsed
    /// only; the caller decides whether the directory exists/applies.
    pub cwd: Option<String>,
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

    /// Feed one PTY chunk; returns whatever sequences completed within it.
    /// A bare BEL in ground state is *not* reported here — that's the
    /// engine's `on_bell` callback's job.
    pub fn scan(&mut self, bytes: &[u8]) -> OscScan {
        let mut out = OscScan::default();
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
                        self.finalize(&mut out);
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
                        self.finalize(&mut out);
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

    fn finalize(&mut self, out: &mut OscScan) {
        let payload = String::from_utf8_lossy(&self.buf).into_owned();
        self.buf.clear();
        let Some((code, rest)) = payload.split_once(';') else {
            return;
        };
        match code {
            "9" => match rest.strip_prefix("9;") {
                // OSC 9 subcommand 9 is ConEmu/Windows Terminal "report
                // cwd", not a notification. Windows Terminal's canonical
                // pwsh snippet wraps the path in double quotes.
                Some(path) => {
                    let path = path.trim_matches('"');
                    if !path.is_empty() {
                        out.cwd = Some(path.to_string());
                    }
                }
                // Anything else after `OSC 9;` is a notification message
                // (semicolons included).
                None => out.notifications.push(OscNotification {
                    title: None,
                    body: Some(rest.to_string()),
                }),
            },
            // OSC 7: cwd report as a `file://host/path` URI.
            "7" => {
                if let Some(dir) = parse_file_uri(rest) {
                    out.cwd = Some(dir);
                }
            }
            // OSC 777: `notify;TITLE;BODY` — BODY may contain semicolons,
            // and may be absent entirely.
            "777" => {
                let Some((kind, args)) = rest.split_once(';') else {
                    return;
                };
                if kind != "notify" {
                    return;
                }
                let (title, body) = match args.split_once(';') {
                    Some((t, b)) => (t.to_string(), Some(b.to_string())),
                    None => (args.to_string(), None),
                };
                out.notifications.push(OscNotification {
                    title: Some(title),
                    body,
                });
            }
            _ => {}
        }
    }
}

/// Parse an OSC 7 `file://host/path` URI into a plain path. The host part
/// is ignored — a wrong-machine path (e.g. relayed by a manual `ssh`
/// session with remote shell integration) is filtered by the tab loop's
/// directory-exists check, not here. Percent-escapes are decoded, and the
/// file-URI form of a Windows drive path (`/C:/Users/x`) loses its leading
/// slash.
fn parse_file_uri(uri: &str) -> Option<String> {
    let rest = uri.strip_prefix("file://")?;
    let path_start = rest.find('/')?;
    let path = percent_decode(&rest[path_start..]);
    let b = path.as_bytes();
    if b.len() >= 3 && b[0] == b'/' && b[1].is_ascii_alphabetic() && b[2] == b':' {
        return Some(path[1..].to_string());
    }
    Some(path)
}

fn percent_decode(s: &str) -> String {
    fn hex(b: u8) -> Option<u8> {
        (b as char).to_digit(16).map(|d| d as u8)
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(hi << 4 | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
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
        assert_eq!(got.notifications, vec![note(None, Some("hello world"))]);
        assert_eq!(got.cwd, None);
    }

    #[test]
    fn osc777_with_title_and_body() {
        let mut s = OscNotifyScanner::new();
        let got = s.scan(b"\x1b]777;notify;Claude Code;Task finished\x07");
        assert_eq!(
            got.notifications,
            vec![note(Some("Claude Code"), Some("Task finished"))]
        );
    }

    #[test]
    fn osc777_st_terminated_and_semicolons_in_body() {
        let mut s = OscNotifyScanner::new();
        let got = s.scan(b"\x1b]777;notify;T;a;b;c\x1b\\");
        assert_eq!(got.notifications, vec![note(Some("T"), Some("a;b;c"))]);
    }

    #[test]
    fn osc777_title_only() {
        let mut s = OscNotifyScanner::new();
        let got = s.scan(b"\x1b]777;notify;Just a title\x07");
        assert_eq!(got.notifications, vec![note(Some("Just a title"), None)]);
    }

    #[test]
    fn split_across_chunks_byte_at_a_time() {
        let mut s = OscNotifyScanner::new();
        let seq = b"\x1b]777;notify;Sp;lit\x07";
        let mut got = Vec::new();
        for &b in seq.iter() {
            got.extend(s.scan(&[b]).notifications);
        }
        assert_eq!(got, vec![note(Some("Sp"), Some("lit"))]);
    }

    #[test]
    fn non_notify_osc_ignored() {
        let mut s = OscNotifyScanner::new();
        // Title change (OSC 0), color query (OSC 10), 777 without notify.
        assert!(s.scan(b"\x1b]0;window title\x07").notifications.is_empty());
        assert!(s.scan(b"\x1b]10;?\x07").notifications.is_empty());
        assert!(s.scan(b"\x1b]777;other;x\x07").notifications.is_empty());
        // Scanner is back in ground and still works.
        assert_eq!(
            s.scan(b"\x1b]9;ok\x07").notifications,
            vec![note(None, Some("ok"))]
        );
    }

    #[test]
    fn plain_text_and_bare_bel_produce_nothing() {
        let mut s = OscNotifyScanner::new();
        let got = s.scan(b"hello\x07world\x1b[31mred\x1b[0m");
        assert!(got.notifications.is_empty());
        assert_eq!(got.cwd, None);
    }

    #[test]
    fn osc7_file_uri_sets_cwd() {
        let mut s = OscNotifyScanner::new();
        let got = s.scan(b"\x1b]7;file://mac.local/Users/me/dev\x07");
        assert!(got.notifications.is_empty());
        assert_eq!(got.cwd.as_deref(), Some("/Users/me/dev"));
    }

    #[test]
    fn osc7_decodes_escapes_and_strips_windows_drive_slash() {
        let mut s = OscNotifyScanner::new();
        let got = s.scan(b"\x1b]7;file:///C:/Program%20Files\x1b\\");
        assert_eq!(got.cwd.as_deref(), Some("C:/Program Files"));
    }

    #[test]
    fn osc7_without_path_ignored() {
        let mut s = OscNotifyScanner::new();
        assert_eq!(s.scan(b"\x1b]7;file://\x07").cwd, None);
        assert_eq!(s.scan(b"\x1b]7;notauri\x07").cwd, None);
    }

    #[test]
    fn osc99_windows_terminal_cwd_is_not_a_notification() {
        let mut s = OscNotifyScanner::new();
        // Windows Terminal's canonical pwsh prompt hook quotes the path.
        let got = s.scan(b"\x1b]9;9;\"C:\\Users\\me\"\x07");
        assert!(got.notifications.is_empty());
        assert_eq!(got.cwd.as_deref(), Some("C:\\Users\\me"));
        // Unquoted works too.
        let got = s.scan(b"\x1b]9;9;D:\\src\x1b\\");
        assert_eq!(got.cwd.as_deref(), Some("D:\\src"));
    }

    #[test]
    fn last_cwd_report_in_chunk_wins() {
        let mut s = OscNotifyScanner::new();
        let got = s.scan(b"\x1b]7;file:///a\x07\x1b]7;file:///b\x07");
        assert_eq!(got.cwd.as_deref(), Some("/b"));
    }

    #[test]
    fn oversized_payload_is_truncated_not_lost() {
        let mut s = OscNotifyScanner::new();
        let mut seq = b"\x1b]9;".to_vec();
        seq.extend(std::iter::repeat(b'x').take(MAX_OSC_BUF * 2));
        seq.push(0x07);
        let got = s.scan(&seq).notifications;
        assert_eq!(got.len(), 1);
        let body = got[0].body.as_deref().unwrap();
        // "9;" counts toward the buffer, so the body is bounded but present.
        assert!(body.len() <= MAX_OSC_BUF);
        assert!(body.starts_with("xxx"));
        // State machine resynced: a following sequence still parses.
        assert_eq!(
            s.scan(b"\x1b]9;ok\x07").notifications,
            vec![note(None, Some("ok"))]
        );
    }

    #[test]
    fn esc_aborts_osc() {
        let mut s = OscNotifyScanner::new();
        // ESC followed by a CSI mid-OSC abandons the notification.
        assert!(s.scan(b"\x1b]9;abandoned\x1b[31m").notifications.is_empty());
        assert_eq!(
            s.scan(b"\x1b]9;ok\x07").notifications,
            vec![note(None, Some("ok"))]
        );
    }
}
