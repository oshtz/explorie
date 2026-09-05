use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use explorie_plugin_protocol::{
    ActionEffect, ActionRequest, Contribution, Detail, EntryDecoration, Inspection, Manifest,
    Plugin, PluginAction,
};
use serde_json::Value;

const OUTPUT_LIMIT: u64 = 8 * 1024 * 1024;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(8);

// Arguments never pass through a shell. Git errors can contain credential-bearing remotes.
fn git(path: &Path, arguments: &[&OsStr]) -> Result<Option<Vec<u8>>, String> {
    let mut command = Command::new("git");
    command
        .arg("--no-optional-locks")
        .args(["-c", "core.fsmonitor=false"])
        .arg("-C")
        .arg(path)
        .args(arguments)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "Git could not start; install Git and ensure it is on PATH".to_string())?;
    let stdout = child.stdout.take().ok_or("Git output is unavailable")?;
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout
            .take(OUTPUT_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes);
        let _ = sender.send(result);
    });
    let deadline = Instant::now() + COMMAND_TIMEOUT;
    let mut output = None;
    loop {
        if let Ok(bytes) = receiver.try_recv() {
            output = Some(bytes.map_err(|_| "Could not read Git output".to_string()));
            if output.as_ref().is_some_and(|result| {
                result
                    .as_ref()
                    .is_ok_and(|bytes| bytes.len() as u64 > OUTPUT_LIMIT)
            }) {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Repository status exceeds the supported output limit".into());
            }
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return Ok(None);
                }
                let bytes = match output {
                    Some(result) => result?,
                    None => receiver
                        .recv_timeout(Duration::from_secs(1))
                        .map_err(|_| "Git output timed out")?
                        .map_err(|_| "Could not read Git output")?,
                };
                if bytes.len() as u64 > OUTPUT_LIMIT {
                    return Err("Repository status exceeds the supported output limit".into());
                }
                return Ok(Some(bytes));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Could not wait for Git".into());
            }
            Ok(None) => {}
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Git status timed out; use Refresh to retry".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn run(path: &Path, args: &[&str]) -> Result<Option<Vec<u8>>, String> {
    git(path, &args.iter().map(OsStr::new).collect::<Vec<_>>())
}

#[derive(Clone, Default)]
struct Status {
    branch: String,
    oid: String,
    upstream: Option<String>,
    ahead: u64,
    behind: u64,
    staged: usize,
    changed: usize,
    untracked: usize,
    conflicted: usize,
    entries: Vec<(PathBuf, String)>,
    github: Option<String>,
}

fn parse_status(bytes: &[u8]) -> Result<Status, String> {
    let mut result = Status::default();
    let mut records = bytes.split(|byte| *byte == 0);
    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        let text = String::from_utf8_lossy(record);
        if let Some(value) = text.strip_prefix("# branch.head ") {
            result.branch = value.into();
            continue;
        }
        if let Some(value) = text.strip_prefix("# branch.oid ") {
            result.oid = value.into();
            continue;
        }
        if let Some(value) = text.strip_prefix("# branch.upstream ") {
            result.upstream = Some(value.into());
            continue;
        }
        if let Some(value) = text.strip_prefix("# branch.ab ") {
            let mut values = value.split_whitespace();
            result.ahead = values
                .next()
                .unwrap_or("+0")
                .trim_start_matches('+')
                .parse()
                .unwrap_or(0);
            result.behind = values
                .next()
                .unwrap_or("-0")
                .trim_start_matches('-')
                .parse()
                .unwrap_or(0);
            continue;
        }
        if text.starts_with('#') || text.starts_with('!') {
            continue;
        }
        let (path, label) = if record.starts_with(b"? ") {
            result.untracked += 1;
            (&record[2..], "Untracked".to_string())
        } else {
            let count = match record[0] {
                b'1' => 9,
                b'2' => 10,
                b'u' => 11,
                _ => return Err("Unsupported Git status response".into()),
            };
            let fields: Vec<_> = record.splitn(count, |b| *b == b' ').collect();
            if fields.len() != count || fields[1].len() != 2 {
                return Err("Malformed Git status response".into());
            }
            let xy = fields[1];
            let label = if record[0] == b'u' {
                result.conflicted += 1;
                "Conflict".into()
            } else {
                let staged = xy[0] != b'.';
                let changed = xy[1] != b'.';
                result.staged += usize::from(staged);
                result.changed += usize::from(changed);
                match (staged, changed) {
                    (true, true) => "Staged + changed",
                    (true, false) => "Staged",
                    _ => "Changed",
                }
                .into()
            };
            if record[0] == b'2' {
                records.next().ok_or("Missing Git rename source")?;
            }
            (fields[count - 1], label)
        };
        #[cfg(unix)]
        let path = {
            use std::os::unix::ffi::OsStrExt;
            PathBuf::from(OsStr::from_bytes(path))
        };
        #[cfg(not(unix))]
        let path = PathBuf::from(String::from_utf8_lossy(path).as_ref());
        result.entries.push((path, label));
    }
    Ok(result)
}

fn github_remote(remote: &str) -> Option<String> {
    let path = if let Some(path) = remote.strip_prefix("git@github.com:") {
        path
    } else {
        let url = url::Url::parse(remote).ok()?;
        if url.host_str() != Some("github.com") || !matches!(url.scheme(), "https" | "ssh" | "git")
        {
            return None;
        }
        return github_path(url.path());
    };
    github_path(path)
}
fn github_path(path: &str) -> Option<String> {
    let path = path.trim_matches('/').trim_end_matches(".git");
    let segments: Vec<_> = path.split('/').collect();
    if segments.len() != 2
        || segments.iter().any(|part| {
            part.is_empty()
                || !part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        })
    {
        return None;
    }
    Some(format!("https://github.com/{path}"))
}

#[derive(Default)]
pub struct GitPlugin {
    cache: HashMap<PathBuf, (Instant, Status)>,
}

impl GitPlugin {
    fn repository(&mut self, context: &Inspection) -> Result<Option<(PathBuf, Status)>, String> {
        let Some(bytes) = run(&context.path, &["rev-parse", "--show-toplevel"])? else {
            return Ok(None);
        };
        let root = PathBuf::from(String::from_utf8_lossy(&bytes).trim_end_matches(['\r', '\n']));
        if !context.force
            && let Some((time, status)) = self.cache.get(&root)
            && time.elapsed() < Duration::from_secs(2)
        {
            return Ok(Some((root, status.clone())));
        }
        let bytes = run(
            &root,
            &[
                "status",
                "--porcelain=v2",
                "-z",
                "--branch",
                "--untracked-files=normal",
                "--ignore-submodules=all",
            ],
        )?
        .ok_or("Git could not inspect this repository")?;
        let mut status = parse_status(&bytes)?;
        if let Some(bytes) = run(&root, &["config", "--get-regexp", "^remote\\..*\\.url$"])? {
            let remotes = String::from_utf8_lossy(&bytes);
            let mut remotes: Vec<_> = remotes
                .lines()
                .filter_map(|line| line.split_once(' '))
                .collect();
            remotes.sort_by_key(|(name, _)| *name != "remote.origin.url");
            status.github = remotes
                .into_iter()
                .find_map(|(_, remote)| github_remote(remote));
        }
        if self.cache.len() >= 32 {
            self.cache.clear();
        }
        self.cache
            .insert(root.clone(), (Instant::now(), status.clone()));
        Ok(Some((root, status)))
    }
}

impl Plugin for GitPlugin {
    fn manifest(&self) -> Manifest {
        serde_json::from_str(include_str!("../plugin.json")).expect("valid bundled manifest")
    }
    fn configure(&mut self, _: Value) -> Result<(), String> {
        self.cache.clear();
        Ok(())
    }
    fn inspect(&mut self, context: Inspection) -> Result<Contribution, String> {
        let mut result = Contribution::empty(&context);
        let Some((root, status)) = self.repository(&context)? else {
            return Ok(result);
        };
        result.root = Some(root.clone());
        result.badge = Some(format!(
            "Git · {}",
            if status.branch == "(detached)" {
                "Detached HEAD"
            } else {
                &status.branch
            }
        ));
        for (label, value) in [
            ("Branch", status.branch.clone()),
            ("Staged", status.staged.to_string()),
            ("Changed", status.changed.to_string()),
            ("Untracked", status.untracked.to_string()),
            ("Conflicts", status.conflicted.to_string()),
            (
                "Cached upstream",
                status.upstream.as_ref().map_or_else(
                    || "No upstream configured".into(),
                    |upstream| {
                        format!(
                            "{upstream}: {} ahead, {} behind (no fetch)",
                            status.ahead, status.behind
                        )
                    },
                ),
            ),
        ] {
            result.details.push(Detail {
                label: label.into(),
                value,
            });
        }
        for entry in &context.entries {
            let labels: Vec<_> = status
                .entries
                .iter()
                .filter(|(path, _)| {
                    let path = root.join(path);
                    path == entry.path || (entry.is_dir && path.starts_with(&entry.path))
                })
                .map(|(_, label)| label.as_str())
                .collect();
            if let Some(label) = labels.first() {
                result.decorations.push(EntryDecoration {
                    path: entry.path.clone(),
                    label: if labels.iter().all(|item| item == label) {
                        (*label).into()
                    } else {
                        "Changes".into()
                    },
                });
            }
        }
        result.actions.push(PluginAction {
            id: "refresh".into(),
            label: "Refresh".into(),
        });
        if status.github.is_some() {
            result.actions.push(PluginAction {
                id: "open-repository".into(),
                label: "Open GitHub Repository".into(),
            });
            if context.selected.len() == 1
                && context.selected[0].is_file()
                && context.selected[0].starts_with(&root)
                && status.oid != "(initial)"
            {
                result.actions.push(PluginAction {
                    id: "open-committed-file".into(),
                    label: "Open Committed File on GitHub".into(),
                });
            }
        }
        Ok(result)
    }
    fn invoke(&mut self, request: ActionRequest) -> Result<ActionEffect, String> {
        if request.action_id == "refresh" {
            self.cache.clear();
            return Ok(ActionEffect::None);
        }
        let (root, status) = self
            .repository(&request.context)?
            .ok_or("This folder is not in a Git repository")?;
        let link = status.github.ok_or("No recognized GitHub remote")?;
        match request.action_id.as_str() {
            "open-repository" => Ok(ActionEffect::OpenUrl(link)),
            "open-committed-file" => {
                if request.context.selected.len() != 1 {
                    return Err("Select one committed file".into());
                }
                let path = request.context.selected[0]
                    .strip_prefix(&root)
                    .map_err(|_| "Select a file in this repository")?;
                let object = format!(
                    "{}:{}",
                    status.oid,
                    path.to_string_lossy().replace('\\', "/")
                );
                if run(&root, &["cat-file", "-e", &object])?.is_none() {
                    return Err("This file does not exist in the current commit".into());
                }
                let mut url = url::Url::parse(&link).map_err(|_| "Invalid GitHub URL")?;
                {
                    let mut segments = url.path_segments_mut().map_err(|_| "Invalid GitHub URL")?;
                    segments.push("blob").push(&status.oid);
                    for component in path.components() {
                        segments.push(&component.as_os_str().to_string_lossy());
                    }
                }
                Ok(ActionEffect::OpenUrl(url.into()))
            }
            _ => Err("Unknown Git action".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_null_records_renames_conflicts_and_unusual_names() {
        let status=parse_status(b"# branch.head main\0# branch.oid abc\0# branch.ab +2 -3\x001 M. N... 100644 100644 100644 a b file with space.md\x002 R. N... 100644 100644 100644 a b R100 new\0old\0u UU N... 100644 100644 100644 100644 a b c conflict\0? newline\nfile\0").unwrap();
        assert_eq!(
            (
                status.staged,
                status.conflicted,
                status.untracked,
                status.ahead,
                status.behind
            ),
            (2, 1, 1, 2, 3)
        );
        assert_eq!(status.entries.len(), 4);
        assert_eq!(status.entries[3].0, PathBuf::from("newline\nfile"));
    }
    #[test]
    fn github_links_strip_credentials_and_reject_other_hosts() {
        assert_eq!(
            github_remote("https://secret@github.com/owner/repo.git").as_deref(),
            Some("https://github.com/owner/repo")
        );
        assert_eq!(
            github_remote("git@github.com:owner/repo.git").as_deref(),
            Some("https://github.com/owner/repo")
        );
        assert!(github_remote("https://github.com.evil/owner/repo").is_none());
        assert!(github_remote("https://github.com/../repo").is_none());
    }
    #[test]
    fn real_repository_worktree_detached_and_cache() {
        let temp = tempfile::tempdir().unwrap();
        run(temp.path(), &["init", "--initial-branch=main"])
            .unwrap()
            .unwrap();
        std::fs::write(temp.path().join("file # space.md"), "hello").unwrap();
        run(temp.path(), &["add", "."]).unwrap().unwrap();
        run(
            temp.path(),
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "-m",
                "fixture",
            ],
        )
        .unwrap()
        .unwrap();
        run(temp.path(), &["checkout", "--detach"])
            .unwrap()
            .unwrap();
        run(
            temp.path(),
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/fixture/repository.git",
            ],
        )
        .unwrap()
        .unwrap();
        let mut plugin = GitPlugin::default();
        let context = Inspection {
            path: temp.path().into(),
            ..Default::default()
        };
        let (_, status) = plugin.repository(&context).unwrap().unwrap();
        assert_eq!(status.branch, "(detached)");
        assert!(
            plugin
                .inspect(context.clone())
                .unwrap()
                .details
                .iter()
                .any(|detail| detail.value == "No upstream configured")
        );
        let ActionEffect::OpenUrl(link) = plugin
            .invoke(ActionRequest {
                action_id: "open-committed-file".into(),
                context: Inspection {
                    selected: vec![temp.path().join("file # space.md")],
                    ..context.clone()
                },
            })
            .unwrap()
        else {
            panic!("Expected committed GitHub link")
        };
        assert_eq!(
            link,
            format!(
                "https://github.com/fixture/repository/blob/{}/file%20%23%20space.md",
                status.oid
            )
        );
        std::fs::write(temp.path().join("untracked"), "x").unwrap();
        assert!(
            plugin
                .invoke(ActionRequest {
                    action_id: "open-committed-file".into(),
                    context: Inspection {
                        selected: vec![temp.path().join("untracked")],
                        ..context.clone()
                    }
                })
                .unwrap_err()
                .contains("does not exist in the current commit")
        );
        assert_eq!(plugin.repository(&context).unwrap().unwrap().1.untracked, 0);
        assert_eq!(
            plugin
                .repository(&Inspection {
                    force: true,
                    ..context
                })
                .unwrap()
                .unwrap()
                .1
                .untracked,
            1
        );
        let worktree = temp.path().join("worktree");
        run(
            temp.path(),
            &["worktree", "add", "--detach", worktree.to_str().unwrap()],
        )
        .unwrap()
        .unwrap();
        assert!(
            plugin
                .repository(&Inspection {
                    path: worktree,
                    ..Default::default()
                })
                .unwrap()
                .is_some()
        );
    }
}
