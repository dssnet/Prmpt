//! Git operations backing the optional git panel, by shelling out to the
//! system `git` binary (no libgit2 dependency; the target audience has git).
//!
//! Like [`crate::localfs`], these are plain blocking calls and the command
//! wrappers in [`crate::commands`] are intentionally **non-`async`** so Tauri
//! runs them on a worker thread — `git status` on a large repo takes real
//! time and must stay off the async runtime.

use std::process::{Command, Output, Stdio};

use crate::error::{AppError, AppResult};
use crate::protocol::{GitBranch, GitCommit, GitFileEntry, GitRepoStatus, GitStatusSnapshot};

/// Outcome of spawning git: a missing binary is a normal panel empty state,
/// not an error, so it's separated from real spawn failures.
enum GitRun {
    Ok(Output),
    GitMissing,
}

fn spawn_git(dir: &str, args: &[&str]) -> AppResult<GitRun> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(dir)
        .args(args)
        // Status queries must never take the index lock (would race the
        // user's own git commands running in the terminal below).
        .env("GIT_OPTIONAL_LOCKS", "0")
        // Never hang a worker thread waiting for credentials on a tty.
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    match cmd.output() {
        Ok(out) => Ok(GitRun::Ok(out)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(GitRun::GitMissing),
        Err(e) => Err(AppError::Io(e)),
    }
}

/// Run git and require success, returning stdout. `ok_codes` lists additional
/// acceptable exit codes (`git diff --no-index` exits 1 when files differ —
/// the normal case). Any other failure surfaces trimmed stderr, which is what
/// the panel shows the user ("nothing to commit", hook output, …).
fn run(dir: &str, args: &[&str], ok_codes: &[i32]) -> AppResult<String> {
    match spawn_git(dir, args)? {
        GitRun::GitMissing => Err(AppError::Other("git not found on PATH".into())),
        GitRun::Ok(out) => {
            let code = out.status.code().unwrap_or(-1);
            if out.status.success() || ok_codes.contains(&code) {
                Ok(String::from_utf8_lossy(&out.stdout).into_owned())
            } else {
                let err = String::from_utf8_lossy(&out.stderr);
                let err = err.trim();
                Err(AppError::Other(if err.is_empty() {
                    format!("git exited with status {code}")
                } else {
                    err.to_string()
                }))
            }
        }
    }
}

/// Resolve `dir` to its enclosing repo and snapshot its status. The two
/// non-repo outcomes (`GitMissing`, `NotARepo`) are values, not errors — the
/// panel renders them as empty states.
pub fn status(dir: &str) -> AppResult<GitRepoStatus> {
    let root = match spawn_git(dir, &["rev-parse", "--show-toplevel"])? {
        GitRun::GitMissing => return Ok(GitRepoStatus::GitMissing),
        GitRun::Ok(out) if !out.status.success() => return Ok(GitRepoStatus::NotARepo),
        GitRun::Ok(out) => String::from_utf8_lossy(&out.stdout).trim().to_string(),
    };
    if root.is_empty() {
        return Ok(GitRepoStatus::NotARepo);
    }

    let raw = run(&root, &["status", "--porcelain=v2", "--branch", "-z"], &[])?;
    let mut snap = parse_status_v2(&raw);
    snap.root = root.clone();
    // Detached HEAD: show the short hash where the branch name would go.
    if snap.branch.is_none() {
        if let Ok(hash) = run(&root, &["rev-parse", "--short", "HEAD"], &[]) {
            let hash = hash.trim();
            if !hash.is_empty() {
                snap.detached_at = Some(hash.to_string());
            }
        }
    }
    Ok(GitRepoStatus::Repo(snap))
}

/// Parse `git status --porcelain=v2 --branch -z` output. NUL-separated; a
/// rename/copy entry (`2 …`) consumes a *second* NUL field holding the
/// original path.
fn parse_status_v2(raw: &str) -> GitStatusSnapshot {
    let mut snap = GitStatusSnapshot {
        root: String::new(),
        branch: None,
        detached_at: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        staged: Vec::new(),
        unstaged: Vec::new(),
    };

    let mut fields = raw.split('\0');
    while let Some(field) = fields.next() {
        if field.is_empty() {
            continue;
        }
        if let Some(rest) = field.strip_prefix("# ") {
            if let Some(head) = rest.strip_prefix("branch.head ") {
                if head != "(detached)" {
                    snap.branch = Some(head.to_string());
                }
            } else if let Some(up) = rest.strip_prefix("branch.upstream ") {
                snap.upstream = Some(up.to_string());
            } else if let Some(ab) = rest.strip_prefix("branch.ab ") {
                for part in ab.split(' ') {
                    if let Some(a) = part.strip_prefix('+') {
                        snap.ahead = a.parse().unwrap_or(0);
                    } else if let Some(b) = part.strip_prefix('-') {
                        snap.behind = b.parse().unwrap_or(0);
                    }
                }
            }
            continue;
        }

        match field.as_bytes().first() {
            Some(b'1') | Some(b'2') => {
                let is_rename = field.starts_with('2');
                // "1 XY sub mH mI mW hH hI path" / "2 XY sub mH mI mW hH hI Xscore path"
                let mut cols = field.splitn(if is_rename { 10 } else { 9 }, ' ');
                let _kind = cols.next();
                let xy = cols.next().unwrap_or("..");
                let path = cols.last().unwrap_or("").to_string();
                // The rename source follows as its own NUL field.
                let orig = if is_rename {
                    fields.next().map(|s| s.to_string())
                } else {
                    None
                };
                let mut xy_chars = xy.chars();
                let x = xy_chars.next().unwrap_or('.');
                let y = xy_chars.next().unwrap_or('.');
                if x != '.' {
                    snap.staged.push(GitFileEntry {
                        path: path.clone(),
                        orig_path: orig.clone(),
                        status: status_word(x),
                    });
                }
                if y != '.' {
                    snap.unstaged.push(GitFileEntry {
                        path,
                        orig_path: orig,
                        status: status_word(y),
                    });
                }
            }
            Some(b'u') => {
                // Unmerged: "u XY sub m1 m2 m3 mW h1 h2 h3 path"
                let path = field.splitn(11, ' ').last().unwrap_or("").to_string();
                snap.unstaged.push(GitFileEntry {
                    path,
                    orig_path: None,
                    status: "conflicted".into(),
                });
            }
            Some(b'?') => {
                let path = field.strip_prefix("? ").unwrap_or("").to_string();
                snap.unstaged.push(GitFileEntry {
                    path,
                    orig_path: None,
                    status: "untracked".into(),
                });
            }
            // "!" (ignored) only appears with --ignored; anything else is a
            // future porcelain extension — skip rather than fail the parse.
            _ => {}
        }
    }

    snap
}

fn status_word(code: char) -> String {
    match code {
        'M' => "modified",
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        'T' => "typechange",
        _ => "modified",
    }
    .into()
}

pub fn stage(repo: &str, paths: &[String]) -> AppResult<()> {
    let mut args: Vec<&str> = vec!["add", "-A", "--"];
    args.extend(paths.iter().map(String::as_str));
    run(repo, &args, &[])?;
    Ok(())
}

pub fn unstage(repo: &str, paths: &[String]) -> AppResult<()> {
    let mut args: Vec<&str> = vec!["restore", "--staged", "--"];
    args.extend(paths.iter().map(String::as_str));
    match run(repo, &args, &[]) {
        Ok(_) => Ok(()),
        // Unborn branch (no commits yet): `restore --staged` can't resolve
        // HEAD; dropping the paths from the index is the same user intent.
        Err(AppError::Other(e)) if e.contains("HEAD") => {
            let mut args: Vec<&str> = vec!["rm", "--cached", "-q", "-r", "--"];
            args.extend(paths.iter().map(String::as_str));
            run(repo, &args, &[])?;
            Ok(())
        }
        Err(e) => Err(e),
    }
}

/// Commit the index with `message`. Returns git's stdout summary line(s).
pub fn commit(repo: &str, message: &str) -> AppResult<String> {
    run(repo, &["commit", "-m", message], &[])
}

/// Unified diff for one file. `staged` diffs the index against HEAD;
/// otherwise the worktree against the index. Untracked files have nothing in
/// either, so they're diffed against /dev/null (`--no-index` exits 1 when the
/// files differ — expected).
pub fn diff_file(repo: &str, path: &str, staged: bool, untracked: bool) -> AppResult<String> {
    if untracked {
        // git-for-Windows understands the literal "/dev/null" spelling.
        return run(
            repo,
            &["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", path],
            &[1],
        );
    }
    let mut args = vec!["diff", "--no-color", "--no-ext-diff"];
    if staged {
        args.push("--cached");
    }
    args.extend(["--", path]);
    run(repo, &args, &[])
}

pub fn branches(repo: &str) -> AppResult<Vec<GitBranch>> {
    let out = run(
        repo,
        &["branch", "--list", "--format=%(HEAD)%09%(refname:short)"],
        &[],
    )?;
    Ok(out
        .lines()
        .filter_map(|line| {
            let (head, name) = line.split_once('\t')?;
            // A detached HEAD synthesizes a "(HEAD detached at <hash>)" entry
            // in the list — not a real branch, not switchable.
            if name.is_empty() || name.starts_with('(') {
                return None;
            }
            Some(GitBranch {
                name: name.to_string(),
                current: head == "*",
            })
        })
        .collect())
}

pub fn switch_branch(repo: &str, name: &str) -> AppResult<()> {
    run(repo, &["switch", name], &[])?;
    Ok(())
}

pub fn create_branch(repo: &str, name: &str) -> AppResult<()> {
    run(repo, &["switch", "-c", name], &[])?;
    Ok(())
}

pub fn log(repo: &str, limit: u32) -> AppResult<Vec<GitCommit>> {
    let n = format!("-n{limit}");
    // Unit separator / record separator: subjects can contain anything
    // printable, but not control characters.
    let out = match run(repo, &["log", &n, "--format=%H%x1f%an%x1f%at%x1f%s%x1e"], &[]) {
        Ok(out) => out,
        // A repo with no commits yet has no log — an empty list, not an error.
        Err(AppError::Other(e))
            if e.contains("does not have any commits") || e.contains("bad default revision") =>
        {
            return Ok(Vec::new());
        }
        Err(e) => return Err(e),
    };
    Ok(out
        .split('\x1e')
        .filter_map(|rec| {
            let rec = rec.trim_start_matches(['\n', '\r']);
            let mut f = rec.split('\x1f');
            let hash = f.next()?.to_string();
            if hash.is_empty() {
                return None;
            }
            Some(GitCommit {
                hash,
                author: f.next().unwrap_or("").to_string(),
                time: f.next().and_then(|t| t.parse().ok()).unwrap_or(0),
                subject: f.next().unwrap_or("").to_string(),
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_branch_header() {
        let raw = "# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0";
        let s = parse_status_v2(raw);
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.upstream.as_deref(), Some("origin/main"));
        assert_eq!(s.ahead, 2);
        assert_eq!(s.behind, 1);
        assert!(s.staged.is_empty() && s.unstaged.is_empty());
    }

    #[test]
    fn parse_detached_head() {
        let raw = "# branch.oid abc\0# branch.head (detached)\0";
        let s = parse_status_v2(raw);
        assert_eq!(s.branch, None);
    }

    #[test]
    fn parse_ordinary_entries() {
        // staged-modified, worktree-modified, and both-at-once
        let raw = "1 M. N... 100644 100644 100644 h h staged.rs\0\
                   1 .M N... 100644 100644 100644 h h dirty.rs\0\
                   1 MM N... 100644 100644 100644 h h both.rs\0\
                   1 A. N... 000000 100644 100644 0 h new.rs\0\
                   1 .D N... 100644 100644 000000 h 0 gone.rs\0";
        let s = parse_status_v2(raw);
        let staged: Vec<_> = s.staged.iter().map(|e| (e.path.as_str(), e.status.as_str())).collect();
        let unstaged: Vec<_> = s.unstaged.iter().map(|e| (e.path.as_str(), e.status.as_str())).collect();
        assert_eq!(
            staged,
            vec![("staged.rs", "modified"), ("both.rs", "modified"), ("new.rs", "added")]
        );
        assert_eq!(
            unstaged,
            vec![("dirty.rs", "modified"), ("both.rs", "modified"), ("gone.rs", "deleted")]
        );
    }

    #[test]
    fn parse_rename_consumes_second_field() {
        // The rename source rides in a second NUL field; a following untracked
        // entry must still parse (i.e. the source wasn't misread as an entry).
        let raw = "2 R. N... 100644 100644 100644 h h R100 new-name.rs\0old-name.rs\0? loose.txt\0";
        let s = parse_status_v2(raw);
        assert_eq!(s.staged.len(), 1);
        assert_eq!(s.staged[0].path, "new-name.rs");
        assert_eq!(s.staged[0].orig_path.as_deref(), Some("old-name.rs"));
        assert_eq!(s.staged[0].status, "renamed");
        assert_eq!(s.unstaged.len(), 1);
        assert_eq!(s.unstaged[0].path, "loose.txt");
        assert_eq!(s.unstaged[0].status, "untracked");
    }

    #[test]
    fn parse_untracked_and_conflicted() {
        let raw = "? a file with spaces.txt\0u UU N... 100644 100644 100644 100644 h h h fight.rs\0";
        let s = parse_status_v2(raw);
        assert_eq!(s.unstaged.len(), 2);
        assert_eq!(s.unstaged[0].path, "a file with spaces.txt");
        assert_eq!(s.unstaged[0].status, "untracked");
        assert_eq!(s.unstaged[1].path, "fight.rs");
        assert_eq!(s.unstaged[1].status, "conflicted");
    }
}
